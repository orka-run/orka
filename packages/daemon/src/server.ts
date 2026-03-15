import type {
  OrkaService,
  ServerCapabilities,
  ServerWelcomeData,
} from "@orka/core";
import {
  PROTOCOL_VERSION,
  PushChannelSchema,
  PushControlRequestSchema,
  canonicalTransportOrigin,
} from "@orka/core";
import { ReconnectStrategy } from "@orka/client";
import type { PushChannel, DataFrame } from "@orka/core";
import { trace } from "@opentelemetry/api";
import { ensureNoiseKeyPair, type NoiseKeyInfo } from "@orka/core/crypto";
import { NoiseServerTransport } from "@orka/core/transport/noise-transport";
import daemonPackageJson from "../package.json";
import type { OrkaConfig } from "./config";
import type { DaemonContext } from "./daemon-context";
import { GracefulShutdown } from "./graceful-shutdown";
import { handleRpcRequest } from "./rpc-handler";
import { LogTailer } from "./log-tailer";
import { getDaemonMetrics, getTracer, persistOtlpJsonTraces, withSpan } from "./tracing";

export interface ServerOptions {
  port: number;
  hostname?: string;
  /** If set, the daemon registers with this relay URL (e.g. ws://relay:7390). */
  relayUrl?: string;
  /** Node ID for relay registration. Defaults to hostname:port. */
  nodeId?: string;
  /** Token for relay authentication. */
  relayToken?: string;
  /** Enable E2E encryption. Auto-generates a node keypair if needed. */
  encrypt?: boolean;
}

interface ServerWebSocketData {
  /** Noise transport instance for encrypted connections */
  noiseTransport?: NoiseServerTransport;
  /** Whether the first message has been received (for protocol detection) */
  firstMessageReceived?: boolean;
}

export const gracefulShutdown = new GracefulShutdown();

export function buildCapabilities(ctx: DaemonContext, encrypt?: boolean): ServerCapabilities {
  return {
    resume: false,
    encryption: encrypt ? "noise-nk" : false,
    multiTurn: true,
    adapters: ctx.providerAdapterRegistry.list(),
    maxConcurrent: ctx.config.limits.maxConcurrent,
    terminal: true,
  };
}

/**
 * Start the orka daemon WS server.
 * Accepts WebSocket connections, dispatches JSON-RPC to the OrkaService.
 * Optionally registers with a relay for multi-machine routing.
 */
export async function startServer(ctx: DaemonContext, svc: OrkaService, opts: ServerOptions) {
  return withSpan("orka.server.start", {}, async () => {
    const { pushHub } = ctx;

    // Load or generate Noise keypair for E2E encryption
    let noiseKeyInfo: NoiseKeyInfo | undefined;
    if (opts.encrypt) {
      noiseKeyInfo = ensureNoiseKeyPair(ctx.orkaHome, "node");
      console.log(`E2E encryption enabled (noise key_id: ${noiseKeyInfo.keyId.slice(0, 30)}...)`);
    }
    const capabilities = buildCapabilities(ctx, opts.encrypt);
    const nodeId = opts.nodeId ?? `${opts.hostname ?? "127.0.0.1"}:${opts.port}`;

    const server = Bun.serve<ServerWebSocketData>({
      port: opts.port,
      hostname: opts.hostname ?? "127.0.0.1",

      async fetch(req, server) {
        const url = new URL(req.url);

        // Health check endpoint — includes public key and key_id for client discovery
        if (url.pathname === "/health") {
          const body: Record<string, unknown> = {
            status: "ok",
            serverVersion: daemonPackageJson.version,
            protocolVersion: PROTOCOL_VERSION,
            capabilities,
          };
          if (noiseKeyInfo) {
            body["publicKey"] = noiseKeyInfo.publicKeyB64;
            body["keyId"] = noiseKeyInfo.keyId;
            body["nodeId"] = nodeId;
          }
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        }

        if (url.pathname === "/v1/traces") {
          if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          try {
            const body = await req.json();
            persistOtlpJsonTraces(body);
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          } catch {
            return new Response(JSON.stringify({ error: "Invalid OTLP JSON payload" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
        }

        // Session completion callback — called by session script on exit
        if (url.pathname === "/session-ended") {
          const sessionId = url.searchParams.get("id");
          // Reap first to update DB status, then broadcast
          await svc.reap();
          if (sessionId) {
            const session = await svc.getSession(sessionId);
            pushHub.broadcast("orchestration.sessionUpdated", {
              sessionId,
              status: session?.status ?? "completed",
            });
          }
          return new Response("ok");
        }

        // Upgrade to WebSocket
        if (server.upgrade(req, { data: {} })) {
          return undefined;
        }
        return new Response("WebSocket upgrade required", { status: 426 });
      },

      websocket: {
        async message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = undefined;
          }

          // --- Noise transport: handshake or encrypted data ---
          if (ws.data.noiseTransport) {
            const transport = ws.data.noiseTransport;

            if (transport.isSecure) {
              // SECURE state: decrypt incoming data frame, process RPC, encrypt response
              const frame = parsed as DataFrame;
              if (!frame || frame.t !== "data" || typeof frame.ct !== "string") {
                // Not a data frame — could be a push control message sent in cleartext
                // after the secure channel is established. Drop it.
                return;
              }

              let rpc: Record<string, unknown>;
              try {
                rpc = transport.decryptData(frame);
              } catch (err) {
                const activeSpan = trace.getActiveSpan();
                if (activeSpan) {
                  activeSpan.addEvent("noise.decrypt_error", {
                    "orka.transport.error_code": "decrypt_error",
                  });
                } else {
                  const tracer = getTracer();
                  const span = tracer.startSpan("orka.noise.transport_error", {
                    attributes: { "orka.transport.error_code": "decrypt_error" },
                  });
                  span.end();
                }
                ws.send(JSON.stringify({
                  t: "transport_error",
                  code: "decrypt_error",
                }));
                return;
              }

              // Handle push control messages that were encrypted
              const controlMessage = PushControlRequestSchema.safeParse(rpc);
              if (controlMessage.success) {
                const knownChannels = controlMessage.data.channels.filter(
                  (ch): ch is PushChannel => PushChannelSchema.safeParse(ch).success,
                );
                if (controlMessage.data.type === "subscribe") {
                  pushHub.subscribe(ws, knownChannels);
                } else {
                  pushHub.unsubscribe(ws, knownChannels);
                }
                return;
              }

              // Reject spawn requests during shutdown
              if (gracefulShutdown.shuttingDown) {
                const req = rpc as { id?: unknown; method?: string };
                if (req?.method === "spawn") {
                  const errResponse: Record<string, unknown> = {
                    jsonrpc: "2.0",
                    id: req.id ?? null,
                    error: { code: -32000, message: "Server shutting down" },
                  };
                  const encFrame = transport.encryptRpc(errResponse);
                  ws.send(JSON.stringify(encFrame));
                  return;
                }
              }

              // Process RPC (no encKey - Noise handles encryption at the transport layer)
              const responseStr = await handleRpcRequest(ctx, svc, JSON.stringify(rpc));
              const responseObj = JSON.parse(responseStr) as Record<string, unknown>;
              const encFrame = transport.encryptRpc(responseObj);
              ws.send(JSON.stringify(encFrame));
              return;
            }

            // Not yet SECURE — still in handshake phase
            const responses = transport.processMessage(parsed);
            for (const resp of responses) {
              ws.send(JSON.stringify(resp));
            }

            // If we just reached SECURE state, record the event and send welcome encrypted
            if (transport.isSecure) {
              const tracer = getTracer();
              const hsSpan = tracer.startSpan("orka.noise.handshake_complete", {
                attributes: { "orka.transport.side": "server" },
              });
              hsSpan.end();
              void withSpan("orka.push.welcome", {}, async () => {
                const sessions = await svc.listSessions();
                const welcome: ServerWelcomeData = {
                  serverVersion: daemonPackageJson.version,
                  sessionCount: sessions.length,
                  protocolVersion: PROTOCOL_VERSION,
                  capabilities,
                };
                // Send welcome as an encrypted push frame
                const pushEnvelope = {
                  type: "push",
                  channel: "server.welcome",
                  sequence: 1,
                  data: welcome,
                };
                const encWelcome = transport.encryptRpc(pushEnvelope);
                ws.send(JSON.stringify(encWelcome));
              });
            }
            return;
          }

          // --- First message: detect protocol ---
          if (!ws.data.firstMessageReceived && noiseKeyInfo && parsed && typeof parsed === "object") {
            const msg = parsed as Record<string, unknown>;
            if (msg["t"] === "client_hello") {
              // New Noise transport path
              ws.data.firstMessageReceived = true;
              const tracer = getTracer();
              const helloSpan = tracer.startSpan("orka.noise.client_hello_received", {
                attributes: { "orka.transport.side": "server" },
              });

              const transport = new NoiseServerTransport({
                nodeId,
                keyId: noiseKeyInfo.keyId,
                staticKeypair: {
                  publicKey: noiseKeyInfo.publicKey,
                  privateKey: noiseKeyInfo.privateKey,
                },
                relayOrigin: canonicalTransportOrigin(opts.relayUrl),
              });
              ws.data.noiseTransport = transport;

              const responses = transport.processMessage(parsed);
              for (const resp of responses) {
                ws.send(JSON.stringify(resp));
              }
              helloSpan.end();
              return;
            }
          }
          ws.data.firstMessageReceived = true;

          // --- Plaintext path (no encryption) ---
          const controlMessage = PushControlRequestSchema.safeParse(parsed);
          if (controlMessage.success) {
            const knownChannels = controlMessage.data.channels.filter(
              (ch): ch is PushChannel => PushChannelSchema.safeParse(ch).success,
            );
            if (controlMessage.data.type === "subscribe") {
              pushHub.subscribe(ws, knownChannels);
            } else {
              pushHub.unsubscribe(ws, knownChannels);
            }
            return;
          }

          // Reject spawn requests during shutdown
          if (gracefulShutdown.shuttingDown) {
            const req = parsed as { id?: unknown; method?: string } | undefined;
            if (req?.method === "spawn") {
              const errResponse = JSON.stringify({
                jsonrpc: "2.0",
                id: req.id ?? null,
                error: { code: -32000, message: "Server shutting down" },
              });
              ws.send(errResponse);
              return;
            }
          }

          const response = await handleRpcRequest(ctx, svc, raw);
          ws.send(response);
        },

        open(ws) {
          getDaemonMetrics().wsConnections.add(1);
          // Always send welcome immediately for all connections.
          // Noise clients will ignore this during the handshake phase (they filter
          // by "t" field and skip messages without it). After the Noise handshake
          // completes, the server also sends an encrypted welcome through the secure
          // channel, which the client can verify.
          void withSpan("orka.push.welcome", {}, async () => {
            const sessions = await svc.listSessions();
            const welcome: ServerWelcomeData = {
              serverVersion: daemonPackageJson.version,
              sessionCount: sessions.length,
              protocolVersion: PROTOCOL_VERSION,
              capabilities,
            };
            pushHub.send(ws, "server.welcome", welcome);
          });
        },

        close(ws) {
          getDaemonMetrics().wsConnections.add(-1);
          pushHub.removeClient(ws);
        },
      },
    });

    // Start log tailer for real-time log streaming
    const logTailer = new LogTailer(svc, pushHub);
    logTailer.start();

    // Register cleanup tasks for graceful shutdown
    gracefulShutdown.onShutdown("log-tailer", async () => logTailer.stop());
    gracefulShutdown.onShutdown("notify-clients", async () => {
      pushHub.broadcast("server.shutdown", {});
    });
    gracefulShutdown.onShutdown("http-server", async () => {
      server.stop();
    });

    // Handle signals for graceful shutdown
    const onSignal = () => {
      console.log("Received shutdown signal, shutting down gracefully...");
      gracefulShutdown.shutdown({ timeout: 5_000 }).then(() => process.exit(0));
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    // Register with relay if configured
    if (opts.relayUrl) {
      registerWithRelay(ctx, svc, opts.relayUrl, nodeId, opts.relayToken);
    }

    return server;
  });
}

/**
 * Connect to relay as a node. Relay forwards client requests to us,
 * we process them and send responses back through the relay.
 */
function registerWithRelay(ctx: DaemonContext, svc: OrkaService, relayUrl: string, nodeId: string, token?: string) {
  void withSpan("orka.server.register_relay", {}, async () => {
    let url = `${relayUrl}/register?node=${encodeURIComponent(nodeId)}`;
    if (token) url += `&token=${encodeURIComponent(token)}`;

    const backoff = new ReconnectStrategy();

    function connect() {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        backoff.reset();
        console.log(`registered with relay as node "${nodeId}"`);
      };

      ws.onmessage = async (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        const response = await handleRpcRequest(ctx, svc, raw);
        ws.send(response);
      };

      ws.onclose = () => {
        const delay = backoff.nextDelay();
        console.log(`relay connection lost, reconnecting in ${Math.round(delay / 1000)}s (attempt ${backoff.attempts})...`);
        setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    connect();
  });
}
