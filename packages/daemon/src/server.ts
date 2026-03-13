import type {
  OrkaService,
  KeyPair,
  ServerCapabilities,
  ServerWelcomeData,
} from "@orka/core";
import {
  PROTOCOL_VERSION,
  PushControlRequestSchema,
  ReconnectStrategy,
} from "@orka/core";
import { deriveSessionKey, ensureKeyPair, loadKeyPair } from "@orka/core/crypto";
import daemonPackageJson from "../package.json";
import { getConfig, type OrkaConfig } from "./config";
import { GracefulShutdown } from "./graceful-shutdown";
import { orchestrationEngine, providerAdapterRegistry } from "./provider-runtime";
import { pushHub } from "./push";
import { handleRpcRequest } from "./rpc-handler";
import { LogTailer } from "./log-tailer";
import { getOrkaHome } from "./db";
import { getDaemonMetrics, persistOtlpJsonTraces, withSpan } from "./tracing";

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
  encKey?: Buffer;
}

export const gracefulShutdown = new GracefulShutdown();

export function buildCapabilities(config: OrkaConfig): ServerCapabilities {
  return {
    resume: false,
    encryption: loadKeyPair(getOrkaHome(), "node") ? "x25519-aes256gcm" : false,
    multiTurn: true,
    adapters: providerAdapterRegistry.list(),
    maxConcurrent: config.limits.maxConcurrent,
    terminal: true,
  };
}

/**
 * Start the orka daemon WS server.
 * Accepts WebSocket connections, dispatches JSON-RPC to the OrkaService.
 * Optionally registers with a relay for multi-machine routing.
 */
export async function startServer(svc: OrkaService, opts: ServerOptions) {
  return withSpan("orka.server.start", {}, async () => {
    void orchestrationEngine;

    // Load or generate node keypair for E2E encryption
    let nodeKeyPair: KeyPair | undefined;
    if (opts.encrypt) {
      nodeKeyPair = ensureKeyPair(getOrkaHome(), "node");
      console.log(`E2E encryption enabled (node pubkey: ${nodeKeyPair.publicKey.slice(0, 20)}...)`);
    }
    const capabilities = buildCapabilities(getConfig());

    const server = Bun.serve<ServerWebSocketData>({
      port: opts.port,
      hostname: opts.hostname ?? "127.0.0.1",

      async fetch(req, server) {
        const url = new URL(req.url);

        // Health check endpoint — includes public key for client discovery
        if (url.pathname === "/health") {
          const body: Record<string, unknown> = {
            status: "ok",
            protocolVersion: PROTOCOL_VERSION,
            capabilities,
          };
          if (nodeKeyPair) body["publicKey"] = nodeKeyPair.publicKey;
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

        // Derive per-connection encryption key from client's public key
        let encKey: Buffer | undefined;
        if (nodeKeyPair) {
          const clientPubKey = url.searchParams.get("pubkey");
          if (clientPubKey) {
            const salt = Buffer.from(clientPubKey + nodeKeyPair.publicKey).toString("base64").slice(0, 44);
            encKey = await deriveSessionKey(nodeKeyPair.privateKey, clientPubKey, salt);
          }
        }

        // Upgrade to WebSocket, pass encKey as data
        if (server.upgrade(req, { data: encKey ? { encKey } : {} })) {
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

          const controlMessage = PushControlRequestSchema.safeParse(parsed);
          if (controlMessage.success) {
            if (controlMessage.data.type === "subscribe") {
              pushHub.subscribe(ws, controlMessage.data.channels);
            } else {
              pushHub.unsubscribe(ws, controlMessage.data.channels);
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

          const encKey = ws.data?.encKey;
          const response = await handleRpcRequest(svc, raw, encKey);
          ws.send(response);
        },

        open(ws) {
          getDaemonMetrics().wsConnections.add(1);
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
      const nodeId = opts.nodeId ?? `${opts.hostname ?? "127.0.0.1"}:${server.port}`;
      registerWithRelay(svc, opts.relayUrl, nodeId, opts.relayToken);
    }

    return server;
  });
}

/**
 * Connect to relay as a node. Relay forwards client requests to us,
 * we process them and send responses back through the relay.
 */
function registerWithRelay(svc: OrkaService, relayUrl: string, nodeId: string, token?: string) {
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
        const response = await handleRpcRequest(svc, raw);
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
