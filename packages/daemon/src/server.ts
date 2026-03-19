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
import { statfsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ReconnectStrategy } from "@orka/client";
import type { PushChannel, DataFrame, TransportPayload } from "@orka/core";
import { trace } from "@opentelemetry/api";
import { ensureNoiseKeyPair, type NoiseKeyInfo } from "@orka/core/crypto";
import { NoiseServerTransport } from "@orka/core/transport/noise-transport";
import daemonPackageJson from "../package.json";
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
    const gracefulShutdown = new GracefulShutdown();

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
          const dbOk = checkDbHealth(ctx);
          const activeSessions = ctx.db.listSessions("running").length;
          const diskFree = checkDiskFree(ctx.orkaHome);

          const body: Record<string, unknown> = {
            status: dbOk ? "ok" : "degraded",
            serverVersion: daemonPackageJson.version,
            protocolVersion: PROTOCOL_VERSION,
            capabilities,
            dbOk,
            activeSessions,
            diskFree,
          };
          if (noiseKeyInfo) {
            body["publicKey"] = noiseKeyInfo.publicKeyB64;
            body["keyId"] = noiseKeyInfo.keyId;
            body["nodeId"] = nodeId;
          }
          return new Response(JSON.stringify(body), {
            status: dbOk ? 200 : 503,
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

        // Hook-based tool approval endpoint — called by supervised-hook.ts
        // POST /api/sessions/:id/tool-approval
        // Long-polls until the dashboard resolves the approval request.
        const toolApprovalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-approval$/);
        if (toolApprovalMatch && req.method === "POST") {
          const sessionId = toolApprovalMatch[1]!;
          try {
            const body = (await req.json()) as {
              toolName: string;
              toolInput: unknown;
              toolUseId: string;
            };
            const result = await ctx.hookApprovalBridge.requestApproval(
              sessionId,
              body.toolName,
              body.toolInput,
              body.toolUseId,
            );
            return new Response(JSON.stringify(result), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return new Response(JSON.stringify({ error: msg }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
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
              // SECURE state: decrypt incoming data frame, dispatch by payload kind
              const frame = parsed as DataFrame;
              if (!frame || frame.t !== "data" || typeof frame.ct !== "string") {
                // Not a data frame in secure mode. Drop it.
                return;
              }

              let payload: TransportPayload;
              try {
                payload = transport.decryptFrame(frame);
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

              // Dispatch by payload kind
              if (payload.kind === "push_control") {
                const controlMessage = PushControlRequestSchema.safeParse(payload.push_control);
                if (controlMessage.success) {
                  const activeSpan = trace.getActiveSpan();
                  if (activeSpan) {
                    activeSpan.addEvent("noise.push_control_decrypted", {
                      "orka.push_control.type": controlMessage.data.type,
                      "orka.push_control.channels": controlMessage.data.channels.length,
                    });
                  }
                  const knownChannels = controlMessage.data.channels.filter(
                    (ch): ch is PushChannel => PushChannelSchema.safeParse(ch).success,
                  );
                  if (controlMessage.data.type === "subscribe") {
                    pushHub.subscribe(ws, knownChannels);
                  } else {
                    pushHub.unsubscribe(ws, knownChannels);
                  }
                }
                return;
              }

              if (payload.kind !== "rpc") {
                return;
              }

              const rpc = payload.rpc;

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

            // If we just reached SECURE state, register push encoder and send welcome
            if (transport.isSecure) {
              // Register encoder so PushHub encrypts push messages for this client
              pushHub.setClientEncoder(ws, (payload) => {
                const push = JSON.parse(payload) as Record<string, unknown>;
                try {
                  const encFrame = transport.encryptPush(push);
                  return JSON.stringify(encFrame);
                } catch (err) {
                  const tracer = getTracer();
                  const errSpan = tracer.startSpan("orka.push.encrypt_error", {
                    attributes: { "orka.error": err instanceof Error ? err.message : String(err) },
                  });
                  errSpan.end();
                  throw err;
                }
              });

              const tracer = getTracer();
              const hsSpan = tracer.startSpan("orka.noise.handshake_complete", {
                attributes: { "orka.transport.side": "server" },
              });
              hsSpan.addEvent("noise.push_encoder_registered");
              hsSpan.end();
              void withSpan("orka.push.welcome", {}, async () => {
                const sessions = await svc.listSessions();
                const welcome: ServerWelcomeData = {
                  serverVersion: daemonPackageJson.version,
                  sessionCount: sessions.length,
                  protocolVersion: PROTOCOL_VERSION,
                  capabilities,
                };
                pushHub.send(ws, "server.welcome" as PushChannel, welcome);
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

    // Clear log tailer offsets when sessions reach terminal status
    ctx.orchestrationEngine.onEvent((event) => {
      if (event.type === "session.completed" || event.type === "session.failed" || event.type === "session.cancelled") {
        logTailer.forget(event.sessionId);
      }
    });

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
      // Delete PID file before exiting so CLI doesn't find a stale PID
      try { unlinkSync(join(ctx.orkaHome, "daemon.pid")); } catch { /* already gone */ }
      gracefulShutdown.shutdown({ timeout: 5_000 }).then(() => process.exit(0));
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    // Register with relay if configured
    if (opts.relayUrl) {
      registerWithRelay(ctx, svc, opts.relayUrl, nodeId, opts.relayToken, noiseKeyInfo);
    }

    return { server, gracefulShutdown };
  });
}

function checkDbHealth(ctx: DaemonContext): boolean {
  return ctx.db.isHealthy();
}

function checkDiskFree(orkaHome: string): boolean {
  try {
    const stats = statfsSync(orkaHome);
    const freeBytes = stats.bavail * stats.bsize;
    return freeBytes > 100 * 1024 * 1024; // > 100MB
  } catch {
    return true; // Assume ok if we can't check
  }
}

/**
 * Connect to relay as a node. Relay forwards client requests to us,
 * we process them and send responses back through the relay.
 *
 * When Noise encryption is enabled (`noiseKeyInfo`), the relay multiplexes
 * multiple client transport sessions over this single WS using a `_rc`
 * (relay client ID) field. Each `_rc` maps to an independent NoiseServerTransport.
 */
function registerWithRelay(
  ctx: DaemonContext,
  svc: OrkaService,
  relayUrl: string,
  nodeId: string,
  token?: string,
  noiseKeyInfo?: NoiseKeyInfo,
) {
  void withSpan("orka.server.register_relay", {}, async () => {
    let url = `${relayUrl}/register?node=${encodeURIComponent(nodeId)}`;
    if (token) url += `&token=${encodeURIComponent(token)}`;

    const backoff = new ReconnectStrategy();

    function connect() {
      // Per-client Noise transport sessions, keyed by relay client ID (_rc).
      // Cleared on reconnect since the relay won't know about old sessions.
      const transportSessions = new Map<string, NoiseServerTransport>();

      const ws = new WebSocket(url);

      ws.onopen = () => {
        backoff.reset();
        console.log(`registered with relay as node "${nodeId}"`);
      };

      ws.onmessage = async (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        // --- Transport message from relay (has _rc field) ---
        if (parsed && typeof parsed._rc === "string" && typeof parsed.t === "string") {
          const relayCid: string = parsed._rc;

          // Helper: send response back through relay with _rc attached.
          // IMPORTANT: spread to avoid mutating the original object (e.g. stored serverHello).
          const sendBack = (msg: Record<string, unknown>) => {
            ws.send(JSON.stringify({ ...msg, _rc: relayCid }));
          };

          // Strip _rc before processing
          const { _rc, ...msg } = parsed;

          let transport = transportSessions.get(relayCid);

          // New client_hello → create Noise transport session
          if (!transport && msg.t === "client_hello" && noiseKeyInfo) {
            transport = new NoiseServerTransport({
              nodeId,
              keyId: noiseKeyInfo.keyId,
              staticKeypair: {
                publicKey: noiseKeyInfo.publicKey,
                privateKey: noiseKeyInfo.privateKey,
              },
              relayOrigin: canonicalTransportOrigin(relayUrl),
            });
            transportSessions.set(relayCid, transport);
          }

          if (!transport) {
            sendBack({ t: "transport_error", code: "no_transport_session" });
            return;
          }

          // SECURE state: decrypt data frame, handle RPC
          if (transport.isSecure) {
            if (msg.t !== "data" || typeof msg.ct !== "string") return;
            let payload: TransportPayload;
            try {
              payload = transport.decryptFrame(msg as DataFrame);
            } catch {
              sendBack({ t: "transport_error", code: "decrypt_error" });
              return;
            }
            if (payload.kind === "rpc") {
              const responseStr = await handleRpcRequest(ctx, svc, JSON.stringify(payload.rpc));
              const responseObj = JSON.parse(responseStr) as Record<string, unknown>;
              const encFrame = transport.encryptRpc(responseObj);
              sendBack(encFrame as Record<string, unknown>);
            }
            // push_control not supported through relay transport yet
            return;
          }

          // Handshake in progress
          const responses = transport.processMessage(msg);
          for (const resp of responses) {
            sendBack(resp as Record<string, unknown>);
          }

          // Just reached SECURE → send encrypted welcome
          if (transport.isSecure) {
            const capabilities = buildCapabilities(ctx, true);
            const sessions = await svc.listSessions();
            const welcome: ServerWelcomeData = {
              serverVersion: daemonPackageJson.version,
              sessionCount: sessions.length,
              protocolVersion: PROTOCOL_VERSION,
              capabilities,
            };
            try {
              const welcomeFrame = transport.encryptPush(welcome);
              sendBack(welcomeFrame as Record<string, unknown>);
            } catch (err) {
              const tracer = getTracer();
              const errSpan = tracer.startSpan("orka.push.encrypt_error", {
                attributes: { "orka.error": err instanceof Error ? err.message : String(err) },
              });
              errSpan.end();
            }
          }
          return;
        }

        // --- Regular JSON-RPC from relay ---
        const response = await handleRpcRequest(ctx, svc, raw);
        ws.send(response);
      };

      ws.onclose = () => {
        transportSessions.clear();
        const delay = backoff.nextDelay();
        console.log(`relay connection lost, reconnecting in ${Math.round(delay / 1000)}s (attempt ${backoff.attempts})...`);
        setTimeout(connect, delay).unref();
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    connect();
  });
}
