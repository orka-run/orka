/**
 * E2E tests for Noise transport protocol error handling.
 *
 * Verifies the daemon correctly handles malformed, corrupted, and
 * adversarial transport messages without crashing or leaking resources.
 *
 * Runs a single in-process daemon with Noise encryption for all tests.
 *
 * Run with: bun test tests/e2e/protocol/protocol-errors.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

// Isolated ORKA_HOME — must be set BEFORE importing daemon modules
const testHome = mkdtempSync(join(tmpdir(), "orka-e2e-protocol-errors-"));
process.env["ORKA_HOME"] = testHome;

import { generateX25519KeyPair } from "../../../packages/core/src/crypto/noise";
import type { DaemonHandle } from "./protocol-helpers";
import {
  startDaemonWithNoise,
  performNoiseHandshake,
  encryptedRpc,
  plainRpc,
  waitForOpen,
  waitForMessage,
  NoiseClientTransport,
  computeKeyId,
} from "./protocol-helpers";

describe("Protocol Error Handling", () => {
  let daemon: DaemonHandle;

  beforeAll(async () => {
    daemon = await startDaemonWithNoise({ nodeId: "proto-err-node" });
  }, 30_000);

  afterAll(async () => {
    await daemon?.stop();
    rmSync(testHome, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 1. Wrong server key: client rejects handshake
  // --------------------------------------------------------------------------

  it("wrong server key: client rejects handshake", async () => {
    // Generate a random keypair that does NOT match the daemon's real key
    const wrongKey = generateX25519KeyPair();

    const transport = new NoiseClientTransport({
      nodeId: daemon.nodeId,
      expectedKeyId: computeKeyId(wrongKey.publicKey),
      remoteStaticPubkey: wrongKey.publicKey,
      relayOrigin: "",
    });

    const ws = new WebSocket(daemon.wsUrl);
    ws.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws);

    // Send client_hello — the expected_key_id won't match the daemon's real key_id
    const clientHello = transport.getClientHello();
    ws.send(JSON.stringify(clientHello));

    // The daemon should respond with a transport_error (key_id_mismatch)
    const response = (await waitForMessage(
      ws,
      (m: any) => m?.t === "transport_error",
    )) as any;

    expect(response.t).toBe("transport_error");
    expect(response.code).toBe("key_id_mismatch");

    ws.close();
  });

  // --------------------------------------------------------------------------
  // 2. Wrong key_id in client_hello produces transport_error
  // --------------------------------------------------------------------------

  it("wrong key_id in client_hello produces transport_error", async () => {
    const ws = new WebSocket(daemon.wsUrl);
    ws.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws);

    // Manually construct client_hello with wrong expected_key_id
    const clientHello = {
      t: "client_hello",
      v: 1,
      noise_suites: ["Noise_NK_25519_ChaChaPoly_SHA256"],
      node_id: daemon.nodeId,
      expected_key_id: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      app_protocols: ["jsonrpc-2.0"],
      features: [],
    };

    ws.send(JSON.stringify(clientHello));

    const response = (await waitForMessage(
      ws,
      (m: any) => m?.t === "transport_error",
    )) as any;

    expect(response.t).toBe("transport_error");
    expect(response.code).toBe("key_id_mismatch");

    ws.close();
  });

  // --------------------------------------------------------------------------
  // 3. Wrong node_id in client_hello produces transport_error
  // --------------------------------------------------------------------------

  it("wrong node_id in client_hello produces transport_error", async () => {
    const ws = new WebSocket(daemon.wsUrl);
    ws.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws);

    const clientHello = {
      t: "client_hello",
      v: 1,
      noise_suites: ["Noise_NK_25519_ChaChaPoly_SHA256"],
      node_id: "wrong-node-id-that-does-not-exist",
      expected_key_id: computeKeyId(daemon.noiseKeyInfo.publicKey),
      app_protocols: ["jsonrpc-2.0"],
      features: [],
    };

    ws.send(JSON.stringify(clientHello));

    const response = (await waitForMessage(
      ws,
      (m: any) => m?.t === "transport_error",
    )) as any;

    expect(response.t).toBe("transport_error");
    expect(response.code).toBe("no_such_node");

    ws.close();
  });

  // --------------------------------------------------------------------------
  // 4. Corrupted Noise data frame returns decrypt error
  // --------------------------------------------------------------------------

  it("corrupted Noise data frame returns decrypt error", async () => {
    // Complete a valid handshake
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );
    ws.addEventListener("error", () => {}); // prevent unhandled error events

    // Build a valid encrypted RPC frame, then corrupt the ciphertext
    const rpc = { jsonrpc: "2.0", id: "corrupt-test", method: "listSessions", params: { filters: {} } };
    const frame = transport.encryptRpc(rpc);

    // Corrupt the base64url ciphertext by flipping bits
    const ctBytes = Buffer.from(frame.ct, "base64url");
    ctBytes[0] ^= 0xff; // flip first byte
    ctBytes[ctBytes.length - 1] ^= 0xff; // flip last byte
    const corruptedFrame = { t: "data", ct: ctBytes.toString("base64url") };

    ws.send(JSON.stringify(corruptedFrame));

    const response = (await waitForMessage(
      ws,
      (m: any) => m?.t === "transport_error",
    )) as any;

    expect(response.t).toBe("transport_error");
    expect(response.code).toBe("decrypt_error");

    ws.close();
  }, 15_000);

  // --------------------------------------------------------------------------
  // 5. Malformed first message handled gracefully
  // --------------------------------------------------------------------------

  it("malformed first message handled gracefully", async () => {
    const ws1 = new WebSocket(daemon.wsUrl);
    ws1.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws1);

    // Send garbage as the first message
    ws1.send("this is not valid json {{{");

    // Wait for ws1 to be fully closed before opening ws2.
    // The daemon may close the connection after receiving garbage.
    await new Promise<void>((resolve) => {
      const closeTimer = setTimeout(() => {
        // If the daemon didn't close it, close it ourselves
        if (ws1.readyState !== WebSocket.CLOSED) {
          ws1.close();
        }
        resolve();
      }, 1000);
      closeTimer.unref();

      ws1.addEventListener("close", () => {
        clearTimeout(closeTimer);
        resolve();
      }, { once: true });
    });

    // Verify daemon is still alive by sending a proper plain RPC on a new connection
    const ws2 = new WebSocket(daemon.wsUrl);
    ws2.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws2);

    const resp = await plainRpc(ws2, "listSessions", { filters: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeInstanceOf(Array);
    expect(resp.jsonrpc).toBe("2.0");
    expect(typeof resp.id).toBe("string");

    ws2.close();
  });

  // --------------------------------------------------------------------------
  // 6. Unsupported noise_suite in client_hello
  // --------------------------------------------------------------------------

  it("unsupported noise_suite in client_hello", async () => {
    const ws = new WebSocket(daemon.wsUrl);
    ws.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws);

    const clientHello = {
      t: "client_hello",
      v: 1,
      noise_suites: ["Noise_XX_invalid_cipher_suite"],
      node_id: daemon.nodeId,
      expected_key_id: computeKeyId(daemon.noiseKeyInfo.publicKey),
      app_protocols: ["jsonrpc-2.0"],
      features: [],
    };

    ws.send(JSON.stringify(clientHello));

    const response = (await waitForMessage(
      ws,
      (m: any) => m?.t === "transport_error",
    )) as any;

    expect(response.t).toBe("transport_error");
    expect(response.code).toBe("unsupported_suite");

    ws.close();
  });

  // --------------------------------------------------------------------------
  // 7. Interleaved Noise and plaintext connections
  // --------------------------------------------------------------------------

  it("interleaved Noise and plaintext connections", async () => {
    // Open Noise connection
    const { ws: noiseWs, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );
    noiseWs.addEventListener("error", () => {}); // prevent unhandled error events

    // Open plain connection simultaneously
    const plainWs = new WebSocket(daemon.wsUrl);
    plainWs.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(plainWs);

    // Send encrypted RPC on the Noise connection
    const encResp = await encryptedRpc(transport, noiseWs, "listSessions", { filters: {} });
    expect(encResp.error).toBeUndefined();
    expect(encResp.result).toBeInstanceOf(Array);
    expect(encResp.jsonrpc).toBe("2.0");
    expect(typeof encResp.id).toBe("string");

    // Send plain RPC on the plain connection
    const plainResp = await plainRpc(plainWs, "listSessions", { filters: {} });
    expect(plainResp.error).toBeUndefined();
    expect(plainResp.result).toBeInstanceOf(Array);
    expect(plainResp.jsonrpc).toBe("2.0");
    expect(typeof plainResp.id).toBe("string");

    // Both returned valid session lists without cross-contamination
    noiseWs.close();
    plainWs.close();
  }, 15_000);

  // --------------------------------------------------------------------------
  // 8. Noise handshake timeout on incomplete handshake
  // --------------------------------------------------------------------------

  it("incomplete Noise handshake does not crash daemon", async () => {
    const transport = new NoiseClientTransport({
      nodeId: daemon.nodeId,
      expectedKeyId: computeKeyId(daemon.noiseKeyInfo.publicKey),
      remoteStaticPubkey: daemon.noiseKeyInfo.publicKey,
      relayOrigin: "",
    });

    const ws = new WebSocket(daemon.wsUrl);
    ws.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws);

    // Send client_hello
    const clientHello = transport.getClientHello();
    ws.send(JSON.stringify(clientHello));

    // Wait for server_hello
    const serverHello = await waitForMessage(ws, (m: any) => m?.t === "server_hello");
    expect(serverHello).toBeTruthy();

    // Process server_hello to get noise_1 — but DO NOT send it
    const noise1Msgs = transport.processMessage(serverHello);
    expect(noise1Msgs.length).toBeGreaterThan(0);

    // Intentionally leave the handshake incomplete — just close the connection
    ws.close();

    // Wait a moment for the server to process the close
    await Bun.sleep(300);

    // Verify the daemon is still alive and functioning
    const ws2 = new WebSocket(daemon.wsUrl);
    ws2.addEventListener("error", () => {}); // prevent unhandled error events
    await waitForOpen(ws2);

    const resp = await plainRpc(ws2, "listSessions", { filters: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeInstanceOf(Array);
    expect(resp.jsonrpc).toBe("2.0");
    expect(typeof resp.id).toBe("string");

    ws2.close();
  }, 15_000);
});
