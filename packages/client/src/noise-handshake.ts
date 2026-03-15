import type { NoiseKeyInfo } from "@orka/core/crypto";
import { NoiseClientTransport } from "@orka/core/transport/noise-transport";

export interface NoiseHandshakeOptions {
  nodeId: string;
  serverKey: NoiseKeyInfo;
  relayOrigin: string;
  timeoutMs?: number;
}

/**
 * Drive a Noise NK handshake over a WebSocket connection.
 * Returns the NoiseClientTransport in SECURE state.
 */
export function driveNoiseHandshake(
  ws: WebSocket,
  opts: NoiseHandshakeOptions,
): Promise<NoiseClientTransport> {
  const transport = new NoiseClientTransport({
    nodeId: opts.nodeId,
    expectedKeyId: opts.serverKey.keyId,
    remoteStaticPubkey: opts.serverKey.publicKey,
    relayOrigin: opts.relayOrigin,
  });

  return new Promise<NoiseClientTransport>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Noise handshake timeout"));
    }, opts.timeoutMs ?? 10_000);
    timeout.unref();

    const originalOnMessage = ws.onmessage;

    ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      // Skip non-handshake messages (handshake messages have a "t" field)
      const msg = parsed as Record<string, unknown>;
      if (!msg || typeof msg["t"] !== "string") {
        return;
      }

      try {
        const responses = transport.processMessage(parsed);
        for (const resp of responses) {
          ws.send(JSON.stringify(resp));
        }

        if (transport.isSecure) {
          clearTimeout(timeout);
          ws.onmessage = originalOnMessage;
          resolve(transport);
        }
      } catch (err) {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Send client_hello
    const clientHello = transport.getClientHello();
    ws.send(JSON.stringify(clientHello));
  });
}
