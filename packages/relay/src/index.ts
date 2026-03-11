import type { ServerWebSocket } from "bun";

/**
 * Orka Relay — transparent WS router between CLIs and daemon nodes.
 *
 * Architecture:
 *   CLI ──WS──▶ Relay ──WS──▶ Node (daemon)
 *
 * The relay reads only `node` and `id` from the JSON-RPC envelope for
 * routing. The `params`/`result` payload is forwarded as-is.
 *
 * Nodes connect via /register?node=<id>
 * CLIs connect via /ws (or /)
 */

interface NodeConnection {
  id: string;
  ws: ServerWebSocket<SocketData>;
  registeredAt: number;
  activeRequests: number;
}

type SocketRole = "client" | "node";

interface SocketData {
  role: SocketRole;
  nodeId?: string;
}

const nodes = new Map<string, NodeConnection>();
// Maps request id → { client WS, node id } for routing responses back
const pendingRequests = new Map<string, { client: ServerWebSocket<SocketData>; nodeId: string }>();

function pickNode(requestedNode?: string): NodeConnection | null {
  if (requestedNode) {
    return nodes.get(requestedNode) ?? null;
  }
  // Least-loaded: pick node with fewest active requests
  const nodeList = [...nodes.values()];
  if (nodeList.length === 0) return null;
  let best = nodeList[0];
  for (let i = 1; i < nodeList.length; i++) {
    if (nodeList[i].activeRequests < best.activeRequests) {
      best = nodeList[i];
    }
  }
  return best;
}

export interface RelayOptions {
  port: number;
  hostname?: string;
  /** Shared secret token. If set, all WS connections must provide ?token=<secret>. */
  token?: string;
}

export function startRelay(opts: RelayOptions) {
  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",

    fetch(req, server) {
      const url = new URL(req.url);

      // Token validation (skip for health endpoint)
      if (opts.token && url.pathname !== "/health") {
        const provided = url.searchParams.get("token")
          ?? req.headers.get("authorization")?.replace("Bearer ", "");
        if (provided !== opts.token) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            nodes: [...nodes.values()].map((n) => ({ id: n.id, activeRequests: n.activeRequests })),
            pendingRequests: pendingRequests.size,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname === "/register") {
        const nodeId = url.searchParams.get("node");
        if (!nodeId) {
          return new Response("Missing ?node= parameter", { status: 400 });
        }
        if (server.upgrade(req, { data: { role: "node" as SocketRole, nodeId } })) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      if (url.pathname === "/ws" || url.pathname === "/") {
        if (server.upgrade(req, { data: { role: "client" as SocketRole } })) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        if (ws.data.role === "node") {
          const nodeId = ws.data.nodeId!;
          nodes.set(nodeId, { id: nodeId, ws, registeredAt: Date.now(), activeRequests: 0 });
        }
      },

      message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);

        if (ws.data.role === "client") {
          // Client → Relay → Node
          let requestedNode: string | undefined;
          let requestId: string | undefined;
          try {
            const envelope = JSON.parse(raw);
            requestedNode = envelope.node;
            requestId = envelope.id;
          } catch {
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Relay: parse error" },
            }));
            return;
          }

          const node = pickNode(requestedNode);
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

          // Track which client is waiting for this response
          if (requestId) {
            pendingRequests.set(requestId, { client: ws, nodeId: node.id });
            node.activeRequests++;
          }

          // Forward request to node as-is
          node.ws.send(raw);
        } else if (ws.data.role === "node") {
          // Node → Relay → Client
          let responseId: string | undefined;
          try {
            const envelope = JSON.parse(raw);
            responseId = envelope.id;
          } catch {
            return; // Can't route unparseable response
          }

          if (responseId && pendingRequests.has(responseId)) {
            const { client: clientWs, nodeId: reqNodeId } = pendingRequests.get(responseId)!;
            pendingRequests.delete(responseId);
            const node = nodes.get(reqNodeId);
            if (node) node.activeRequests = Math.max(0, node.activeRequests - 1);
            try {
              clientWs.send(raw);
            } catch {
              // Client disconnected
            }
          }
        }
      },

      close(ws) {
        if (ws.data.role === "node") {
          const nodeId = ws.data.nodeId!;
          nodes.delete(nodeId);
          // Fail all pending requests for this node
          for (const [id, clientWs] of pendingRequests) {
            try {
              clientWs.send(JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: 503, message: `Node ${nodeId} disconnected` },
              }));
            } catch { /* client gone */ }
            pendingRequests.delete(id);
          }
        }
      },
    },
  });

  return server;
}

// CLI entry point for `orka relay`
if (import.meta.main) {
  const port = parseInt(process.argv[2] || "7390", 10);
  const server = startRelay({ port });
  console.log(`orka relay listening on ws://0.0.0.0:${server.port}`);
  console.log("  nodes register at:  /register?node=<id>");
  console.log("  clients connect at: /ws");
}
