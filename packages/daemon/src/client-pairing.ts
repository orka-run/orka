/**
 * Client-side pairing orchestration.
 *
 * Drives the full pairing flow: parse code → open WS → SPAKE2 handshake
 * → Noise NK verification → save node → auto-connect.
 */

import { PairingClient, type PairingClientResult } from "@orka/core/pairing";
import { parsePairingCode, toBase64url } from "@orka/core/crypto/protocol";
import { driveNoiseHandshake } from "@orka/client";
import type { StoredNode } from "@orka/core";
import type { PairWithNodeParams, PairWithNodeResult } from "@orka/core";
import type { NodeRegistry } from "./node-registry";
import type { RemoteNodeManager } from "./remote-nodes";
import { withSpan } from "./tracing";

const PAIRING_TIMEOUT_MS = 30_000;

export interface ClientPairingDeps {
  registry: NodeRegistry;
  remoteNodes: RemoteNodeManager;
}

export async function performClientPairing(
  params: PairWithNodeParams,
  deps: ClientPairingDeps,
): Promise<PairWithNodeResult> {
  return withSpan("orka.pairing.client", {}, () => doPerformClientPairing(params, deps));
}

async function doPerformClientPairing(
  params: PairWithNodeParams,
  deps: ClientPairingDeps,
): Promise<PairWithNodeResult> {
  const { registry, remoteNodes } = deps;

  // 1. Parse pairing code
  const { secret } = parsePairingCode(params.pairingCode);

  // 2. Build relay pairing URL using enrollId from PairingClient
  const relayUrl = params.relayUrl.replace(/\/$/, "");
  const tokenParam = params.relayToken
    ? `?token=${encodeURIComponent(params.relayToken)}`
    : "";

  // Create PairingClient to get enrollId (derived from secret)
  let pairingClient: PairingClient | null = null;
  let pairingWs: WebSocket | null = null;
  let noiseWs: WebSocket | null = null;

  try {
    // 3. Open WebSocket to relay pairing endpoint
    const wsResult = await withTimeout(
      new Promise<WebSocket>((resolve, reject) => {
        // We need the enrollId first — create client with a temp send callback
        const tempClient = new PairingClient({
          secret,
          relayOrigin: relayUrl,
          onSend: () => {},
        });

        const pairUrl = `${relayUrl}/v1/pair/${tempClient.enrollId}${tokenParam}`;
        const ws = new WebSocket(pairUrl);

        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("Failed to connect to relay pairing endpoint"));
      }),
      PAIRING_TIMEOUT_MS,
      "Pairing relay connection timed out",
    );
    pairingWs = wsResult;

    // 4. Create PairingClient wired to the WebSocket
    pairingClient = new PairingClient({
      secret,
      relayOrigin: relayUrl,
      onSend: (msg) => {
        if (pairingWs && pairingWs.readyState === WebSocket.OPEN) {
          pairingWs.send(JSON.stringify(msg));
        }
      },
    });

    // 5. Run SPAKE2 handshake
    const bootstrapResult = await withTimeout(
      runPairingHandshake(pairingClient, pairingWs),
      PAIRING_TIMEOUT_MS,
      "Pairing handshake timed out",
    );

    // 6. Open Noise verification WebSocket to node
    const nodePath = bootstrapResult.nodePaths[0];
    if (!nodePath) {
      throw new Error("No node paths in bootstrap result");
    }

    noiseWs = await withTimeout(
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(nodePath);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error(`Failed to connect to node at ${nodePath}`));
      }),
      PAIRING_TIMEOUT_MS,
      "Noise verification connection timed out",
    );

    // 7. Drive Noise NK handshake to verify the server's static key
    await withTimeout(
      driveNoiseHandshake(noiseWs, {
        nodeId: bootstrapResult.nodeId,
        serverKey: {
          publicKey: bootstrapResult.noiseStaticPubkey,
          keyId: bootstrapResult.noiseKeyId,
        },
        relayOrigin: relayUrl,
      }),
      PAIRING_TIMEOUT_MS,
      "Noise handshake timed out",
    );

    // 8. Confirm Noise verification to server
    pairingClient.confirmNoiseVerified();

    // 9. Save node to registry
    const storedNode: StoredNode = {
      nodeId: bootstrapResult.nodeId,
      nodeName: bootstrapResult.nodeName,
      relayUrl: params.relayUrl,
      relayToken: params.relayToken,
      nodePaths: bootstrapResult.nodePaths,
      pairedAt: new Date().toISOString(),
      noiseStaticPubkey: toBase64url(bootstrapResult.noiseStaticPubkey),
      noiseKeyId: bootstrapResult.noiseKeyId,
      autoConnect: true,
    };
    registry.save(storedNode);

    // 10. Close pairing WebSockets before connecting via RemoteNodeManager
    closeWs(pairingWs);
    pairingWs = null;
    closeWs(noiseWs);
    noiseWs = null;

    // 11. Auto-connect via RemoteNodeManager
    await remoteNodes.connect(storedNode);

    return {
      nodeId: bootstrapResult.nodeId,
      nodeName: bootstrapResult.nodeName,
    };
  } finally {
    closeWs(pairingWs);
    closeWs(noiseWs);
  }
}

/**
 * Run the SPAKE2 pairing handshake over the WebSocket.
 * Resolves with the PairingClientResult when bootstrap is received.
 */
function runPairingHandshake(
  client: PairingClient,
  ws: WebSocket,
): Promise<PairingClientResult> {
  return new Promise((resolve, reject) => {
    ws.onmessage = async (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      try {
        const result = await client.handleMessage(raw);
        if (result) {
          resolve(result);
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    ws.onclose = () => {
      if (!client.completed && client.state !== "AWAIT_NOISE_VERIFY") {
        reject(new Error("Pairing WebSocket closed before handshake completed"));
      }
    };

    ws.onerror = () => {
      reject(new Error("Pairing WebSocket error"));
    };

    // Kick off the handshake
    client.start();
  });
}

function closeWs(ws: WebSocket | null): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close(1000);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer === "object" && typeof timer.unref === "function") {
      timer.unref();
    }
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
