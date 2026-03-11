import type { OrkaService } from "@orka/core";
import { handleRpcRequest } from "./rpc-handler";

export interface ServerOptions {
  port: number;
  hostname?: string;
  /** If set, the daemon registers with this relay URL (e.g. ws://relay:7390/register?node=mynode). */
  relayUrl?: string;
  /** Node ID for relay registration. Defaults to hostname:port. */
  nodeId?: string;
}

/**
 * Start the orka daemon WS server.
 * Accepts WebSocket connections, dispatches JSON-RPC to the OrkaService.
 * Optionally registers with a relay for multi-machine routing.
 */
export function startServer(svc: OrkaService, opts: ServerOptions) {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",

    fetch(req, server) {
      const url = new URL(req.url);

      // Health check endpoint
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      }

      // Upgrade to WebSocket
      if (server.upgrade(req)) {
        return undefined;
      }
      return new Response("WebSocket upgrade required", { status: 426 });
    },

    websocket: {
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        const response = await handleRpcRequest(svc, raw);
        ws.send(response);
      },

      open(ws) {
        // Connection established
      },

      close(ws) {
        // Connection closed
      },
    },
  });

  // Register with relay if configured
  if (opts.relayUrl) {
    const nodeId = opts.nodeId ?? `${opts.hostname ?? "127.0.0.1"}:${server.port}`;
    registerWithRelay(svc, opts.relayUrl, nodeId);
  }

  return server;
}

/**
 * Connect to relay as a node. Relay forwards client requests to us,
 * we process them and send responses back through the relay.
 */
function registerWithRelay(svc: OrkaService, relayUrl: string, nodeId: string) {
  const url = `${relayUrl}/register?node=${encodeURIComponent(nodeId)}`;

  function connect() {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log(`registered with relay as node "${nodeId}"`);
    };

    ws.onmessage = async (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const response = await handleRpcRequest(svc, raw);
      ws.send(response);
    };

    ws.onclose = () => {
      console.log("relay connection lost, reconnecting in 5s...");
      setTimeout(connect, 5000);
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  connect();
}
