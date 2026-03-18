/**
 * Orka Relay — multi-tenant transparent WS router between CLIs and daemon nodes.
 *
 * Architecture:
 *   CLI ──WS──▶ Relay ──WS──▶ Node (daemon)
 *
 * The relay forwards opaque Noise-encrypted transport frames between clients
 * and daemon nodes. It never inspects payload content.
 *
 * Multi-tenant: each account has isolated nodes. Clients can only reach their own nodes.
 * Auth: API keys (SHA-256 hashed, cached in memory).
 * Rate limiting: per-account sliding window.
 * Metering: usage events buffered and flushed to SQLite.
 *
 * Nodes connect via /register?node=<id>
 * CLIs connect via /ws (or /)
 * Self-service: POST /v1/signup, /v1/keys, /v1/account, /v1/usage
 */

import type { ServerWebSocket, Server } from "bun";
import { RelayState, type SocketData, type AnySocketData, type TransportBinding } from "./state";
import { AuthManager, extractApiKey } from "./auth";
import { handleApiRequest, SignupRateLimiter } from "./api";
import { RateLimiter, GlobalRateLimiter } from "./rate-limiter";
import { UsageMeter } from "./metering";
import { AbuseDetector } from "./abuse";
import { loadRelayConfig } from "./config";
import { openRelayDb, migrateRelayDb, getRelayHome } from "./db";
import { SingleInstanceCluster } from "./cluster";
import { metrics, initRelayTracing, shutdownRelayTracing, withSpan, withSpanSync } from "./tracing";
import { PairingRouter } from "./pairing";

// --- Relay Options ---

export interface RelayOptions {
  port: number;
  hostname?: string;
  /** Path to config TOML. */
  configPath?: string;
  /** Override data directory (default: ORKA_RELAY_DATA or ~/.orka-relay). */
  dataDir?: string;
}

export interface RelayHandle {
  server: Server<AnySocketData>;
  /** Graceful shutdown: stop accepting, drain in-flight, flush, close DB. */
  shutdown: (opts?: { drainTimeoutMs?: number }) => Promise<void>;
}

// --- Start Relay ---

export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const dataDir = opts.dataDir ?? getRelayHome();
  const config = loadRelayConfig(dataDir, opts.configPath);
  initRelayTracing(config.observability.traceFile ? { traceFile: config.observability.traceFile } : undefined);
  return withSpan("orka.relay.start", {
    "orka.port": opts.port,
    "orka.hostname": opts.hostname ?? config.server.hostname,
  }, async () => {
    // --- Composition root: create all dependencies ---
    const db = openRelayDb(dataDir);
    await migrateRelayDb(db, dataDir);
    const state = new RelayState();
    const rateLimiter = new RateLimiter();
    const globalLimiter = new GlobalRateLimiter(config.rateLimits.globalRequestsPerSecond);
    const meter = new UsageMeter(db);
    const abuseDetector = new AbuseDetector();
    const pairingRouter = new PairingRouter();
    const signupRateLimiter = new SignupRateLimiter();
    const cluster = new SingleInstanceCluster({ url: `ws://${opts.hostname ?? config.server.hostname}:${opts.port}` });
    const startTime = Date.now();
    let draining = false;

    const authManager = new AuthManager(db, config);

    const server = Bun.serve<AnySocketData>({
      port: opts.port,
      hostname: opts.hostname ?? config.server.hostname,

      async fetch(req, server) {
        const url = new URL(req.url);

        // --- Health endpoint (public, always available even during drain) ---
        if (url.pathname === "/health") {
          const gs = state.getGlobalStats();
          cluster.updateStats(gs.accounts, gs.totalClients + gs.totalNodes);
          const status = draining ? "draining" : "ok";
          const uptime = Math.floor((Date.now() - startTime) / 1000);

          const key = extractApiKey(req);
          if (key) {
            // Authenticated health: include account-specific info
            const auth = authManager.authenticate(key);
            if (auth.success && auth.ctx) {
              const stats = state.getAccountStats(auth.ctx.accountId);
              const nodes = state.getAccountNodes(auth.ctx.accountId);
              return jsonResponse({
                status,
                version: "0.3.0",
                uptime,
                account: {
                  id: auth.ctx.accountId,
                  tier: auth.ctx.tier,
                  ...stats,
                  nodes,
                },
              });
            }
          }
          return jsonResponse({ status, version: "0.3.0", uptime });
        }

        // Reject all other requests when draining
        if (draining) {
          return new Response(JSON.stringify({ error: "Relay is shutting down" }), {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "5" },
          });
        }

        // --- Pairing WebSocket endpoint ---
        const pairMatch = url.pathname.match(/^\/v1\/pair\/(.+)$/);
        if (pairMatch) {
          const enrollId = pairMatch[1]!;

          const validationError = pairingRouter.validateEnrollId(enrollId);
          if (validationError) {
            return new Response(JSON.stringify({ error: validationError }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }

          const pairKey = extractApiKey(req);
          if (!pairKey) {
            return new Response(JSON.stringify({ error: "Missing API key" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          }
          const pairAuth = authManager.authenticate(pairKey);
          if (!pairAuth.success || !pairAuth.ctx) {
            return new Response(JSON.stringify({ error: pairAuth.error }), {
              status: pairAuth.code ?? 401,
              headers: { "content-type": "application/json" },
            });
          }

          const side = pairingRouter.isPaired(enrollId) ? "joiner" : "registrant";

          const socketData: AnySocketData = {
            role: "pairing" as const,
            enrollId,
            side: side as "registrant" | "joiner",
            accountId: pairAuth.ctx.accountId,
          };

          if (server.upgrade(req, { data: socketData })) {
            return undefined;
          }
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // --- API endpoints ---
        if (url.pathname.startsWith("/v1/")) {
          const apiResponse = await handleApiRequest(req, url, db, config, authManager, signupRateLimiter, state);
          if (apiResponse) return apiResponse;
          return new Response("Not found", { status: 404 });
        }

        // --- WebSocket endpoints require auth ---
        const key = extractApiKey(req);
        if (!key) {
          return new Response(JSON.stringify({ error: "Missing API key" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        const auth = authManager.authenticate(key);
        if (!auth.success || !auth.ctx) {
          metrics.authFailures.inc({ reason: auth.error ?? "unknown" });
          return new Response(JSON.stringify({ error: auth.error }), {
            status: auth.code ?? 401,
            headers: { "content-type": "application/json" },
          });
        }

        const ctx = auth.ctx;

        // --- Node registration ---
        if (url.pathname === "/register") {
          const nodeId = url.searchParams.get("node");
          return withSpan("orka.relay.node_register", {
            "orka.account.id": ctx.accountId,
            "orka.node.id": nodeId ?? "",
          }, async () => {
            if (ctx.permissions !== "node" && ctx.permissions !== "admin") {
              return new Response("Node permission required", { status: 403 });
            }

            if (!nodeId) {
              return new Response("Missing ?node= parameter", { status: 400 });
            }

            // Check max nodes per account
            if (state.getNodeCount(ctx.accountId) >= config.abuse.maxNodesPerAccount) {
              return new Response(`Maximum ${config.abuse.maxNodesPerAccount} nodes per account`, { status: 429 });
            }

            // Check concurrent connections
            const totalConns = state.getClientCount(ctx.accountId) + state.getNodeCount(ctx.accountId);
            if (!rateLimiter.checkConnection(ctx.rateLimits, totalConns)) {
              return new Response("Connection limit exceeded", { status: 429 });
            }

            const socketData: SocketData = {
              role: "node",
              nodeId,
              accountId: ctx.accountId,
              permissions: ctx.permissions,
              keyHash: ctx.keyHash,
              connectedAt: Date.now(),
              messageCount: 0,
              bytesIn: 0,
              bytesOut: 0,
            };

            if (server.upgrade(req, { data: socketData })) {
              return undefined;
            }
            return new Response("WebSocket upgrade failed", { status: 500 });
          });
        }

        // --- Client connection ---
        if (url.pathname === "/ws" || url.pathname === "/") {
          if (ctx.permissions !== "client" && ctx.permissions !== "admin") {
            return new Response("Client permission required", { status: 403 });
          }

          const totalConns = state.getClientCount(ctx.accountId) + state.getNodeCount(ctx.accountId);
          if (!rateLimiter.checkConnection(ctx.rateLimits, totalConns)) {
            return new Response("Connection limit exceeded", { status: 429 });
          }

          const socketData: SocketData = {
            role: "client",
            accountId: ctx.accountId,
            permissions: ctx.permissions,
            keyHash: ctx.keyHash,
            connectedAt: Date.now(),
            messageCount: 0,
            bytesIn: 0,
            bytesOut: 0,
          };

          if (server.upgrade(req, { data: socketData })) {
            return undefined;
          }
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        return new Response("Not found", { status: 404 });
      },

      websocket: {
        open(ws) {
          const data = ws.data;

          // --- Pairing connections ---
          if (data.role === "pairing") {
            const result = pairingRouter.handleConnection(data.enrollId, ws);
            if (!result.accepted) {
              ws.close(1008, result.reason);
            }
            return;
          }

          withSpanSync("orka.relay.connection.open", {
            "orka.account.id": data.accountId,
            "orka.role": data.role,
            "orka.node.id": data.nodeId ?? "",
          }, () => {
            if (data.role === "node") {
              state.registerNode(data.accountId, data.nodeId!, ws as ServerWebSocket<SocketData>);
              metrics.connectionsOpened.inc({ account_id: data.accountId, role: "node" });
              metrics.registeredNodes.inc({ account_id: data.accountId });
              meter.recordConnection(data.accountId, "node_connect", data.nodeId);
            } else {
              state.addClient(data.accountId, ws as ServerWebSocket<SocketData>);
              metrics.connectionsOpened.inc({ account_id: data.accountId, role: "client" });
              meter.recordConnection(data.accountId, "ws_connect");
            }
            metrics.activeConnections.inc({ role: data.role });
          });
        },

        message(ws, message) {
          const data = ws.data;

          // --- Pairing connections: forward opaque data ---
          if (data.role === "pairing") {
            pairingRouter.handleMessage(ws, typeof message === "string" ? message : Buffer.from(message));
            return;
          }

          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          const bytes = raw.length;

          data.messageCount++;
          data.bytesIn += bytes;

          if (data.role === "client") {
            handleClientMessage(ws as ServerWebSocket<SocketData>, raw, bytes, data, state, rateLimiter, globalLimiter, config, meter);
          } else if (data.role === "node") {
            handleNodeMessage(ws as ServerWebSocket<SocketData>, raw, bytes, data, state);
          }
        },

        close(ws) {
          const data = ws.data;

          // --- Pairing connections ---
          if (data.role === "pairing") {
            pairingRouter.handleClose(ws);
            return;
          }

          withSpanSync("orka.relay.connection.close", {
            "orka.account.id": data.accountId,
            "orka.role": data.role,
            "orka.node.id": data.nodeId ?? "",
          }, () => {
            if (data.role === "node") {
              // Notify and clean up transport clients bound to this node
              const transportClients = state.getTransportClientsForNode(data.accountId, data.nodeId!);
              for (const clientWs of transportClients) {
                try {
                  clientWs.send(JSON.stringify({ t: "transport_error", code: "node_disconnected" }));
                } catch { /* client gone */ }
                state.removeTransportClient(clientWs);
                metrics.activeTransportSessions.dec({ account_id: data.accountId });
              }
              state.removeNode(data.accountId, data.nodeId!);
              metrics.connectionsClosed.inc({ account_id: data.accountId, role: "node" });
              metrics.registeredNodes.dec({ account_id: data.accountId });
              meter.recordConnection(data.accountId, "node_disconnect", data.nodeId);
            } else {
              // Clean up transport binding if any
              const clientBinding = state.getTransportBinding(ws as ServerWebSocket<SocketData>);
              if (clientBinding) {
                metrics.activeTransportSessions.dec({ account_id: data.accountId });
              }
              state.removeTransportClient(ws as ServerWebSocket<SocketData>);
              state.removeClient(data.accountId, ws as ServerWebSocket<SocketData>);
              metrics.connectionsClosed.inc({ account_id: data.accountId, role: "client" });
              meter.recordConnection(data.accountId, "ws_disconnect");
            }
            metrics.activeConnections.dec({ role: data.role });
          });
        },
      },
    });

    async function shutdown(shutdownOpts?: { drainTimeoutMs?: number }): Promise<void> {
      const timeout = shutdownOpts?.drainTimeoutMs ?? 30_000;
      await withSpan("orka.relay.shutdown", {
        "orka.drain_timeout_ms": timeout,
      }, async () => {
        console.log("relay: shutting down...");
        draining = true;

        // Flush all subsystems
        authManager.shutdown();
        signupRateLimiter.shutdown();
        pairingRouter.shutdown();
        meter.shutdown();
        abuseDetector.shutdown();
        rateLimiter.shutdown();
        db.close();

        // Stop the server
        server.stop(true);
        console.log("relay: shutdown complete");
      });
      await shutdownRelayTracing();
    }

    return { server, shutdown };
  });
}

// --- Message Handlers ---

/**
 * Handle all client messages. Clients must use Noise transport:
 * - client_hello initiates a transport binding to a node
 * - Once bound, all subsequent messages are forwarded to the bound node
 * - Non-transport messages are rejected
 */
function handleClientMessage(
  ws: ServerWebSocket<SocketData>,
  raw: string,
  bytes: number,
  data: SocketData,
  state: RelayState,
  rateLimiter: RateLimiter,
  globalLimiter: GlobalRateLimiter,
  config: any,
  meter: UsageMeter,
): void {
  // Fast path: client already bound in transport mode → forward all messages
  const binding = state.getTransportBinding(ws);
  if (binding) {
    forwardClientTransport(ws, raw, bytes, data, binding, state);
    return;
  }

  // Only accept transport init (client_hello)
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ t: "transport_error", code: "parse_error" }));
    return;
  }

  if (parsed?.t === "client_hello") {
    handleTransportInit(ws, parsed, bytes, data, state, rateLimiter, globalLimiter, config, meter);
    return;
  }

  // Reject non-transport messages — clients must use Noise transport
  ws.send(JSON.stringify({ t: "transport_error", code: "transport_required" }));
}

/**
 * Handle all node messages. Nodes send transport frames with _rc field
 * for routing back to the bound client.
 */
function handleNodeMessage(
  _ws: ServerWebSocket<SocketData>,
  raw: string,
  bytes: number,
  data: SocketData,
  state: RelayState,
): void {
  let envelope: any;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return; // Can't route unparseable message
  }

  // Transport message from node (has _rc field) → route to bound client
  if (envelope && typeof envelope._rc === "string") {
    const relayCid: string = envelope._rc;
    const clientWs = state.getTransportClientWs(data.accountId, relayCid);
    if (!clientWs) return;

    // Strip _rc before forwarding to client
    const { _rc, ...clientMsg } = envelope;
    try {
      clientWs.send(JSON.stringify(clientMsg));
    } catch { /* client gone */ }
    metrics.bytesOut.inc({ account_id: data.accountId, direction: "node" }, bytes);
  }
}

// --- Transport Message Handlers ---

/**
 * Handle client_hello: extract node_id, find node, create transport binding,
 * add _rc (relay client ID), and forward to node.
 */
function handleTransportInit(
  ws: ServerWebSocket<SocketData>,
  parsed: any,
  bytes: number,
  data: SocketData,
  state: RelayState,
  rateLimiter: RateLimiter,
  globalLimiter: GlobalRateLimiter,
  config: any,
  meter: UsageMeter,
): void {
  // Rate limiting
  if (!globalLimiter.check()) {
    ws.send(JSON.stringify({ t: "transport_error", code: "rate_limited" }));
    return;
  }
  const limits = config.rateLimits;
  const accountLimits = {
    accountId: data.accountId,
    requestsPerMinute: limits.defaultRequestsPerMinute,
    requestsPerHour: limits.defaultRequestsPerHour,
    concurrentConnections: limits.defaultConcurrentConnections,
    maxMessageBytes: limits.defaultMaxMessageBytes,
  };
  if (!rateLimiter.checkMessageSize(accountLimits, bytes)) {
    ws.send(JSON.stringify({ t: "transport_error", code: "message_too_large" }));
    return;
  }
  const rateResult = rateLimiter.check(data.accountId, accountLimits);
  if (!rateResult.allowed) {
    ws.send(JSON.stringify({ t: "transport_error", code: "rate_limited" }));
    return;
  }

  // Extract target node from client_hello
  const nodeId = parsed.node_id;
  if (!nodeId || typeof nodeId !== "string") {
    ws.send(JSON.stringify({ t: "transport_error", code: "missing_node_id" }));
    return;
  }

  const node = state.getNode(data.accountId, nodeId);
  if (!node) {
    ws.send(JSON.stringify({ t: "transport_error", code: "node_not_found" }));
    return;
  }

  // Create transport binding (client <-> node)
  const relayCid = state.bindTransportClient(ws, data.accountId, nodeId);
  metrics.activeTransportSessions.inc({ account_id: data.accountId });

  withSpanSync("orka.relay.transport.bind", {
    "orka.node.id": nodeId,
    "orka.account.id": data.accountId,
    "orka.relay.cid": relayCid,
  }, () => {});

  // Add _rc and forward to node
  parsed._rc = relayCid;
  node.ws.send(JSON.stringify(parsed));

  metrics.bytesIn.inc({ account_id: data.accountId, direction: "client" }, bytes);
  meter.recordConnection(data.accountId, "ws_connect");
}

/**
 * Forward a transport-mode client message to the bound node.
 * Adds _rc so the node can route the response back.
 */
function forwardClientTransport(
  ws: ServerWebSocket<SocketData>,
  raw: string,
  bytes: number,
  data: SocketData,
  binding: TransportBinding,
  state: RelayState,
): void {
  const node = state.getNode(data.accountId, binding.nodeId);
  if (!node) {
    ws.send(JSON.stringify({ t: "transport_error", code: "node_disconnected" }));
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  parsed._rc = binding.relayCid;
  node.ws.send(JSON.stringify(parsed));

  metrics.bytesIn.inc({ account_id: data.accountId, direction: "client" }, bytes);
}

// --- Helpers ---

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- CLI Entry Point ---

if (import.meta.main) {
  const port = parseInt(process.argv[2] || "7390", 10);
  const handle = await startRelay({ port });
  console.log(`orka relay listening on ws://0.0.0.0:${handle.server.port}`);
  console.log("  signup:           POST /v1/signup");
  console.log("  nodes register:   /register?node=<id>");
  console.log("  clients connect:  /ws (Noise transport required)");

  // Graceful shutdown on SIGTERM/SIGINT
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\nreceived ${signal}, starting graceful shutdown...`);
      await handle.shutdown();
      process.exit(0);
    });
  }
}
