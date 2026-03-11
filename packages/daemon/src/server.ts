import type { OrkaService } from "@orka/core";
import { handleRpcRequest } from "./rpc-handler";

export interface ServerOptions {
  port: number;
  hostname?: string;
}

/**
 * Start the orka daemon WS server.
 * Accepts WebSocket connections, dispatches JSON-RPC to the OrkaService.
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

  return server;
}
