import type { OrkaService, KeyPair } from "@orka/core";
import { deriveSessionKey, ensureKeyPair, ReconnectStrategy } from "@orka/core";
import { handleRpcRequest } from "./rpc-handler";
import { getOrkaHome } from "./db";
import { withSpan } from "./tracing";

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

/**
 * Start the orka daemon WS server.
 * Accepts WebSocket connections, dispatches JSON-RPC to the OrkaService.
 * Optionally registers with a relay for multi-machine routing.
 */
export async function startServer(svc: OrkaService, opts: ServerOptions) {
  return withSpan("orka.server.start", {}, async () => {
    // Load or generate node keypair for E2E encryption
    let nodeKeyPair: KeyPair | undefined;
    if (opts.encrypt) {
      nodeKeyPair = ensureKeyPair(getOrkaHome(), "node");
      console.log(`E2E encryption enabled (node pubkey: ${nodeKeyPair.publicKey.slice(0, 20)}...)`);
    }

    const server = Bun.serve({
      port: opts.port,
      hostname: opts.hostname ?? "127.0.0.1",

      async fetch(req, server) {
        const url = new URL(req.url);

        // Health check endpoint — includes public key for client discovery
        if (url.pathname === "/health") {
          const body: any = { status: "ok" };
          if (nodeKeyPair) body.publicKey = nodeKeyPair.publicKey;
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
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
        if (server.upgrade(req, { data: { encKey } })) {
          return undefined;
        }
        return new Response("WebSocket upgrade required", { status: 426 });
      },

      websocket: {
        async message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          const encKey = (ws.data as any)?.encKey as Buffer | undefined;
          const response = await handleRpcRequest(svc, raw, encKey);
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
