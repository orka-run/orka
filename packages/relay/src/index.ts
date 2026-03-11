/**
 * Orka Relay — multi-tenant transparent WS router between CLIs and daemon nodes.
 *
 * Architecture:
 *   CLI ──WS──▶ Relay ──WS──▶ Node (daemon)
 *
 * The relay reads only `id`, `node`, and `method` from the JSON-RPC envelope for
 * routing. The `params`/`result` payload is forwarded as-is (E2E encrypted).
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

import type { ServerWebSocket } from "bun";
import { RelayState, type SocketData } from "./state";
import { authenticate, extractApiKey, flushAuthUpdates } from "./auth";
import { handleApiRequest } from "./api";
import { RateLimiter, GlobalRateLimiter } from "./rate-limiter";
import { getRelayConfig } from "./config";
import { metrics, initRelayTracing, shutdownRelayTracing, withSpan } from "./tracing";

// --- Allowed Methods (service enforcement) ---

const ALLOWED_METHODS = new Set([
  "spawn", "stop", "reap", "getSession", "listSessions", "getTask",
  "setKept", "getTags", "getResult", "captureOutput", "getLogContent",
  "isAlive", "sendInput", "getDiff", "merge", "deleteSessions", "pruneSessions",
]);

// --- Relay Options ---

export interface RelayOptions {
  port: number;
  hostname?: string;
  /** Legacy shared token (backward compat). */
  token?: string;
  /** Path to config TOML. */
  configPath?: string;
}

// --- Start Relay ---

export function startRelay(opts: RelayOptions) {
  const config = getRelayConfig();
  const state = new RelayState();
  const rateLimiter = new RateLimiter();
  const globalLimiter = new GlobalRateLimiter(config.rateLimits.globalRequestsPerSecond);

  // Apply legacy token from opts to config
  if (opts.token && !config.auth.legacyToken) {
    config.auth.legacyToken = opts.token;
  }

  initRelayTracing({ traceFile: config.observability.traceFile });

  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname ?? config.server.hostname,

    async fetch(req, server) {
      const url = new URL(req.url);

      // --- Health endpoint (public) ---
      if (url.pathname === "/health") {
        const key = extractApiKey(req);
        if (key) {
          // Authenticated health: show account info
          const auth = authenticate(key);
          if (auth.success && auth.ctx) {
            const stats = state.getAccountStats(auth.ctx.accountId);
            const nodes = state.getAccountNodes(auth.ctx.accountId);
            return jsonResponse({
              status: "ok",
              version: "0.2.0",
              account: {
                id: auth.ctx.accountId,
                nodes,
                ...stats,
              },
            });
          }
        }
        return jsonResponse({ status: "ok", version: "0.2.0" });
      }

      // --- API endpoints ---
      if (url.pathname.startsWith("/v1/")) {
        const apiResponse = await handleApiRequest(req, url, state);
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

      const auth = authenticate(key);
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
        if (ctx.permissions !== "node" && ctx.permissions !== "admin") {
          return new Response("Node permission required", { status: 403 });
        }

        const nodeId = url.searchParams.get("node");
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
        if (data.role === "node") {
          state.registerNode(data.accountId, data.nodeId!, ws);
          metrics.connectionsOpened.inc({ account_id: data.accountId, role: "node" });
          metrics.registeredNodes.inc({ account_id: data.accountId });
        } else {
          state.addClient(data.accountId, ws);
          metrics.connectionsOpened.inc({ account_id: data.accountId, role: "client" });
        }
        metrics.activeConnections.inc({ role: data.role });
      },

      message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        const data = ws.data;
        const bytes = raw.length;

        data.messageCount++;
        data.bytesIn += bytes;

        if (data.role === "client") {
          handleClientMessage(ws, raw, bytes, data, state, rateLimiter, globalLimiter, config);
        } else if (data.role === "node") {
          handleNodeMessage(ws, raw, bytes, data, state);
        }
      },

      close(ws) {
        const data = ws.data;
        if (data.role === "node") {
          // Fail pending requests for this node
          const failed = state.failRequestsForNode(data.accountId, data.nodeId!);
          for (const pr of failed) {
            try {
              pr.client.send(JSON.stringify({
                jsonrpc: "2.0",
                id: pr.method, // We don't have the request ID here, but the client will handle timeout
                error: { code: 503, message: `Node ${data.nodeId} disconnected` },
              }));
            } catch { /* client gone */ }
          }
          state.removeNode(data.accountId, data.nodeId!);
          metrics.connectionsClosed.inc({ account_id: data.accountId, role: "node" });
          metrics.registeredNodes.dec({ account_id: data.accountId });
        } else {
          state.failRequestsForClient(ws);
          state.removeClient(data.accountId, ws);
          metrics.connectionsClosed.inc({ account_id: data.accountId, role: "client" });
        }
        metrics.activeConnections.dec({ role: data.role });
      },
    },
  });

  return server;
}

// --- Message Handlers ---

function handleClientMessage(
  ws: ServerWebSocket<SocketData>,
  raw: string,
  bytes: number,
  data: SocketData,
  state: RelayState,
  rateLimiter: RateLimiter,
  globalLimiter: GlobalRateLimiter,
  config: any,
): void {
  // Parse envelope (plaintext fields only)
  let requestId: string | undefined;
  let requestedNode: string | undefined;
  let method: string | undefined;

  try {
    const envelope = JSON.parse(raw);

    // Validate JSON-RPC structure
    if (envelope.jsonrpc !== "2.0" || typeof envelope.id !== "string") {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: envelope.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      }));
      return;
    }

    requestId = envelope.id;
    requestedNode = envelope.node;
    method = envelope.method;
  } catch {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Relay: parse error" },
    }));
    return;
  }

  // Service enforcement: method must be in allowed set
  if (method && !ALLOWED_METHODS.has(method)) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId ?? null,
      error: { code: -32601, message: `Method not allowed: ${method}` },
    }));
    return;
  }

  // Global rate limit
  if (!globalLimiter.check()) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId ?? null,
      error: { code: 503, message: "Relay overloaded. Try again later." },
    }));
    return;
  }

  // Per-account rate limit
  // Rate limits are loaded from config defaults; the auth context was validated on WS upgrade
  const limits = config.rateLimits;
  {
    const accountLimits = {
      accountId: data.accountId,
      requestsPerMinute: limits.defaultRequestsPerMinute,
      requestsPerHour: limits.defaultRequestsPerHour,
      concurrentConnections: limits.defaultConcurrentConnections,
      maxMessageBytes: limits.defaultMaxMessageBytes,
    };
    // Message size check
    if (!rateLimiter.checkMessageSize(accountLimits, bytes)) {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code: 413, message: "Message too large" },
      }));
      return;
    }

    const result = rateLimiter.check(data.accountId, accountLimits);
    if (!result.allowed) {
      metrics.rateLimitHits.inc({ account_id: data.accountId, limit_type: "request" });
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code: 429, message: "Rate limit exceeded", data: { retryAfter: result.retryAfter } },
      }));
      return;
    }
  }

  // Pick node within account scope
  const node = state.pickNode(data.accountId, requestedNode);
  if (!node) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId ?? null,
      error: {
        code: 503,
        message: requestedNode
          ? `Node not found: ${requestedNode}`
          : "No nodes available",
      },
    }));
    return;
  }

  // Track request
  if (requestId) {
    state.trackRequest(data.accountId, requestId, {
      client: ws,
      nodeId: node.id,
      accountId: data.accountId,
      method: method ?? "unknown",
      bytesIn: bytes,
      startedAt: Date.now(),
    });
  }

  // Forward to node as-is
  node.ws.send(raw);

  // Metrics
  metrics.requestsTotal.inc({ account_id: data.accountId, method: method ?? "unknown" });
  metrics.bytesIn.inc({ account_id: data.accountId, direction: "client" }, bytes);
  metrics.messageSize.record({ account_id: data.accountId, direction: "client" }, bytes);
}

function handleNodeMessage(
  ws: ServerWebSocket<SocketData>,
  raw: string,
  bytes: number,
  data: SocketData,
  state: RelayState,
): void {
  // Parse response ID
  let responseId: string | undefined;
  try {
    const envelope = JSON.parse(raw);
    responseId = envelope.id;
  } catch {
    return; // Can't route unparseable response
  }

  if (!responseId) return;

  const pr = state.resolveRequest(data.accountId, responseId);
  if (!pr) return;

  // Compute latency
  const latencyMs = Date.now() - pr.startedAt;

  // Forward to client
  try {
    pr.client.send(raw);
  } catch {
    // Client disconnected
  }

  // Metrics
  metrics.requestDuration.record({ account_id: data.accountId, method: pr.method }, latencyMs);
  metrics.bytesOut.inc({ account_id: data.accountId, direction: "node" }, bytes);
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
  const server = startRelay({ port });
  console.log(`orka relay listening on ws://0.0.0.0:${server.port}`);
  console.log("  signup:           POST /v1/signup");
  console.log("  nodes register:   /register?node=<id>");
  console.log("  clients connect:  /ws");
}
