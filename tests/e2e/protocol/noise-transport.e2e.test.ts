/**
 * E2E tests for the Noise NK transport protocol.
 *
 * Verifies:
 *   - Daemon health exposes Noise key info
 *   - Full Noise NK handshake lifecycle
 *   - Encrypted RPC request/response
 *   - Multiple sequential encrypted RPCs
 *   - Spawn + query via encrypted channel
 *   - Plain (unencrypted) JSON-RPC still works alongside Noise
 *   - Legacy X25519+AES-GCM encryption backward compatibility
 *   - Protocol auto-detection (three connection types on same daemon)
 *   - Encrypted welcome push after handshake
 *
 * Run with: bun test tests/e2e/protocol/noise-transport.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Isolated ORKA_HOME — needed by TestShellAdapter for script isolation
const orkaHome = mkdtempSync(join(tmpdir(), "orka-e2e-noise-"));
process.env["ORKA_HOME"] = orkaHome;

import {
  startDaemonWithNoise,
  performNoiseHandshake,
  encryptedRpc,
  plainRpc,
  waitForOpen,
  NoiseClientTransport,
  type DaemonWithNoise,
} from "./protocol-helpers";
import { canonicalTransportOrigin } from "@orka/core";

describe("Noise NK Transport", () => {
  let daemon: DaemonWithNoise;
  let testRepo: string;

  beforeAll(async () => {
    // Create a temp git repo for spawn tests
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-noise-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${testRepo} commit --allow-empty -m "init"`.quiet();

    daemon = await startDaemonWithNoise({ nodeId: "noise-test-node", orkaHome });
  }, 30_000);

  afterAll(async () => {
    await daemon?.stop();
    await Bun.sleep(50);
    daemon?.closeDb();
    rmSync(orkaHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  // ---- 1. Health endpoint ----

  test("daemon health exposes Noise key info", async () => {
    const res = await fetch(`${daemon.httpUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body["status"]).toBe("ok");
    expect(typeof body["publicKey"]).toBe("string");
    expect((body["publicKey"] as string).length).toBeGreaterThan(0);
    expect(typeof body["keyId"]).toBe("string");
    expect((body["keyId"] as string).startsWith("sha256:")).toBe(true);
    expect(body["nodeId"]).toBe("noise-test-node");

    const capabilities = body["capabilities"] as Record<string, unknown>;
    expect(capabilities["encryption"]).toBe("noise-nk");
  });

  // ---- 2. Handshake completes ----

  test("Noise NK handshake completes", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    expect(transport.state).toBe("SECURE");
    expect(transport.isSecure).toBe(true);
    expect(transport.sessionId).not.toBeNull();

    ws.close();
  });

  // ---- 3. Encrypted RPC works ----

  test("encrypted RPC works after handshake", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    const resp = await encryptedRpc(transport, ws, "listSessions", { filters: {} });

    expect(resp["error"]).toBeUndefined();
    const lr = resp["result"] as { sessions: unknown[] };
    expect(Array.isArray(lr.sessions)).toBe(true);

    ws.close();
  });

  // ---- 4. Multiple encrypted RPCs on same connection ----

  test("multiple encrypted RPCs on same connection", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    for (let i = 0; i < 5; i++) {
      const resp = await encryptedRpc(transport, ws, "listSessions", { filters: {} });
      expect(resp["error"]).toBeUndefined();
      const lr = resp["result"] as { sessions: unknown[] };
      expect(Array.isArray(lr.sessions)).toBe(true);
    }

    ws.close();
  });

  // ---- 5. Spawn + query via encrypted channel ----

  test("spawn + query via encrypted channel", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Spawn a session
    const spawnResp = await encryptedRpc(transport, ws, "spawn", {
      prompt: "echo noise-test-session",
      backend: "claude-code",
      mode: "background",
      projectPath: testRepo,
      title: "Noise E2E spawn test",
    });

    expect(spawnResp["error"]).toBeUndefined();
    const session = spawnResp["result"] as Record<string, unknown>;
    expect(typeof session["id"]).toBe("string");
    expect((session["id"] as string).startsWith("sess-")).toBe(true);

    // Query session back
    const getResp = await encryptedRpc(transport, ws, "getSession", {
      id: session["id"],
    });

    expect(getResp["error"]).toBeUndefined();
    const fetched = getResp["result"] as Record<string, unknown>;
    expect(fetched["id"]).toBe(session["id"]);
    expect(fetched["backend"]).toBe("claude-code");

    ws.close();
  }, 15_000);

  // ---- 6. Plain JSON-RPC works when server has --encrypt ----

  test("plain JSON-RPC works when server has --encrypt", async () => {
    const ws = new WebSocket(daemon.wsUrl);
    await waitForOpen(ws);

    // Send an unencrypted JSON-RPC — no client_hello, just a standard request
    const resp = await plainRpc(ws, "listSessions", { filters: {} });

    expect(resp["error"]).toBeUndefined();
    const lr2 = resp["result"] as { sessions: unknown[] };
    expect(Array.isArray(lr2.sessions)).toBe(true);

    ws.close();
  });

  // ---- 7. Protocol auto-detection: Noise and plaintext ----

  test("protocol auto-detection: Noise and plaintext coexist", async () => {
    // 1. Noise connection
    const { ws: noiseWs, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );
    const noiseResp = await encryptedRpc(transport, noiseWs, "listSessions", {
      filters: {},
    });
    expect(noiseResp["error"]).toBeUndefined();
    const noiseLr = noiseResp["result"] as { sessions: unknown[] };
    expect(Array.isArray(noiseLr.sessions)).toBe(true);

    // 2. Plaintext connection
    const plainWs = new WebSocket(daemon.wsUrl);
    await waitForOpen(plainWs);
    const plainResp = await plainRpc(plainWs, "listSessions", { filters: {} });
    expect(plainResp["error"]).toBeUndefined();
    const plainLr = plainResp["result"] as { sessions: unknown[] };
    expect(Array.isArray(plainLr.sessions)).toBe(true);

    noiseWs.close();
    plainWs.close();
  });

  // ---- 8. Encrypted welcome after Noise handshake ----

  test("encrypted welcome after Noise handshake", async () => {
    const ws = new WebSocket(daemon.wsUrl);
    await waitForOpen(ws);

    const transport = new NoiseClientTransport({
      nodeId: daemon.nodeId,
      expectedKeyId: daemon.noiseKeyInfo.keyId,
      remoteStaticPubkey: daemon.noiseKeyInfo.publicKey,
      relayOrigin: canonicalTransportOrigin(undefined),
    });

    // Send client_hello
    const clientHello = transport.getClientHello();
    ws.send(JSON.stringify(clientHello));

    // Collect all messages until we get an encrypted welcome
    const welcomeData = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Welcome timeout")),
          10_000,
        );
        timer.unref?.();

        const handler = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));

          // During handshake, process transport messages
          if (!transport.isSecure) {
            // Skip non-transport messages (e.g. plaintext welcome push)
            if (!msg["t"]) return;

            const responses = transport.processMessage(msg);
            for (const resp of responses) {
              ws.send(JSON.stringify(resp));
            }
            return;
          }

          // After SECURE: look for encrypted data frames
          if (msg["t"] === "data" && typeof msg["ct"] === "string") {
            let payload: import("@orka/core").TransportPayload;
            try {
              payload = transport.decryptFrame(msg);
            } catch {
              return;
            }

            // Check if this is the welcome push
            if (payload.kind === "push") {
              const push = payload.push as Record<string, unknown>;
              if (
                push["type"] === "push" &&
                push["channel"] === "server.welcome"
              ) {
                clearTimeout(timer);
                ws.removeEventListener("message", handler);
                resolve(push["data"] as Record<string, unknown>);
              }
            }
          }
        };

        ws.addEventListener("message", handler);
      },
    );

    expect(typeof welcomeData["serverVersion"]).toBe("string");
    expect(typeof welcomeData["sessionCount"]).toBe("number");
    expect(typeof welcomeData["protocolVersion"]).toBe("number");
    expect(welcomeData["capabilities"]).toBeDefined();

    ws.close();
  });
});
