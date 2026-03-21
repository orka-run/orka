/**
 * Advanced E2E tests for the Noise NK transport protocol.
 *
 * Verifies:
 *   - Concurrent encrypted RPCs on a single connection (nonce sync)
 *   - Concurrent independent Noise sessions
 *   - Push events arriving over a Noise channel
 *   - Rapid connect-disconnect cycles (resilience)
 *   - Large RPC payloads over Noise
 *
 * Run with: bun test tests/e2e/protocol/noise-advanced.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const orkaHome = mkdtempSync(join(tmpdir(), "orka-e2e-noise-adv-"));

import {
  startDaemonWithNoise,
  performNoiseHandshake,
  encryptedRpc,
  waitForOpen,
  waitForMessage,
  type DaemonWithNoise,
  type SecureConnection,
} from "./protocol-helpers";
import type { DataFrame } from "@orka/core";

describe("Noise NK Transport — Advanced", () => {
  let daemon: DaemonWithNoise;
  let testRepo: string;

  beforeAll(async () => {
    // Create a temp git repo for spawn tests
    testRepo = mkdtempSync(join(tmpdir(), "orka-e2e-noise-adv-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${testRepo} commit --allow-empty -m "init"`.quiet();

    daemon = await startDaemonWithNoise({ nodeId: "noise-adv-test-node", orkaHome });
  }, 30_000);

  afterAll(async () => {
    await daemon?.stop();
    await Bun.sleep(50);
    daemon?.closeDb();
    rmSync(orkaHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  // ---- 1. Concurrent encrypted RPCs on same connection ----

  test("concurrent encrypted RPCs on same connection", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Fire 15 RPCs concurrently on the same connection
    const count = 15;
    const promises: Promise<Record<string, unknown>>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        encryptedRpc(transport, ws, "listSessions", { filters: {} }),
      );
    }

    const results = await Promise.all(promises);

    // Every response should succeed with a valid session array
    expect(results.length).toBe(count);
    for (let i = 0; i < count; i++) {
      const r = results[i];
      if (!r) throw new Error(`expected result at index ${i}`);
      expect(r["error"]).toBeUndefined();
      expect(Array.isArray((r["result"] as { sessions: unknown[] }).sessions)).toBe(true);
    }

    // All response IDs should be unique (each RPC got its own response)
    const ids = results.map((r) => r["id"]);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(count);

    ws.close();
  }, 15_000);

  // ---- 2. Concurrent connections with independent Noise sessions ----

  test("concurrent connections with independent Noise sessions", async () => {
    // Open 5 independent connections, each with its own Noise handshake
    const connectionCount = 5;
    const connections: SecureConnection[] = [];

    const connectPromises = Array.from({ length: connectionCount }, () =>
      performNoiseHandshake(
        daemon.wsUrl,
        daemon.noiseKeyInfo,
        daemon.nodeId,
      ),
    );

    const established = await Promise.all(connectPromises);
    connections.push(...established);

    // Verify all connections reached SECURE state
    for (const conn of connections) {
      expect(conn.transport.isSecure).toBe(true);
    }

    // Send RPCs concurrently on all connections
    const rpcPromises = connections.map((conn, idx) =>
      encryptedRpc(conn.transport, conn.ws, "listSessions", { filters: {} })
        .then((resp) => ({ idx, resp })),
    );

    const rpcResults = await Promise.all(rpcPromises);

    // Each connection should have received a valid response
    expect(rpcResults.length).toBe(connectionCount);
    for (const { resp } of rpcResults) {
      expect(resp["error"]).toBeUndefined();
      expect(Array.isArray((resp["result"] as { sessions: unknown[] }).sessions)).toBe(true);
    }

    // Do a second round to confirm all connections are still functional
    const round2Promises = connections.map((conn) =>
      encryptedRpc(conn.transport, conn.ws, "listSessions", { filters: {} }),
    );
    const round2Results = await Promise.all(round2Promises);
    for (const resp of round2Results) {
      expect(resp["error"]).toBeUndefined();
      expect(Array.isArray((resp["result"] as { sessions: unknown[] }).sessions)).toBe(true);
    }

    // Clean up all connections
    for (const conn of connections) {
      conn.ws.close();
    }
  }, 30_000);

  // ---- 3. Push events arrive over Noise channel ----

  test("push events arrive encrypted over Noise channel", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Subscribe to orchestration.sessionUpdated via an encrypted push control message.
    // The server handles encrypted push_control payloads in the Noise path.
    const subscribeMsg = {
      type: "subscribe",
      channels: ["orchestration.sessionUpdated"],
    };
    const subFrame = transport.encryptPushControl(subscribeMsg);
    ws.send(JSON.stringify(subFrame));

    // Give the subscription time to register
    await Bun.sleep(50);

    // Set up a listener for push events. Push messages for Noise clients are
    // encrypted as data frames with kind: "push" in the transport payload.
    const pushPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", handler);
        reject(new Error("Push event timeout"));
      }, 15_000);
      timer.unref?.();

      const handler = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(String(event.data));

          // Push events arrive as encrypted data frames
          if (parsed["t"] === "data" && typeof parsed["ct"] === "string") {
            try {
              const payload = transport.decryptFrame(parsed as DataFrame);
              if (payload.kind === "push") {
                const push = payload.push as Record<string, unknown>;
                if (
                  push["type"] === "push" &&
                  push["channel"] === "orchestration.sessionUpdated"
                ) {
                  clearTimeout(timer);
                  ws.removeEventListener("message", handler);
                  resolve(push);
                  return;
                }
              }
            } catch {
              // Ignore frames we can't decrypt
            }
          }
        } catch {
          // Ignore parse errors
        }
      };
      ws.addEventListener("message", handler);
    });

    // Spawn a session to trigger a sessionUpdated push event
    const spawnResp = await encryptedRpc(transport, ws, "spawn", {
      prompt: "echo push-test",
      backend: "claude-code",
      mode: "background",
      projectPath: testRepo,
      title: "Push event test",
    });
    expect(spawnResp["error"]).toBeUndefined();
    const session = spawnResp["result"] as Record<string, unknown>;
    expect(typeof session["id"]).toBe("string");

    // Wait for the push event
    const pushEvent = await pushPromise;
    expect(pushEvent["type"]).toBe("push");
    expect(pushEvent["channel"]).toBe("orchestration.sessionUpdated");
    expect(pushEvent["data"]).toBeDefined();

    const pushData = pushEvent["data"] as Record<string, unknown>;
    expect(typeof pushData["sessionId"]).toBe("string");
    expect(typeof pushData["status"]).toBe("string");

    ws.close();
  }, 30_000);

  // ---- 4. Rapid connect-disconnect cycles don't crash daemon ----

  test("rapid connect-disconnect cycles don't crash daemon", async () => {
    const cycleCount = 25;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < cycleCount; i++) {
      promises.push(
        (async () => {
          const ws = new WebSocket(daemon.wsUrl);
          try {
            await waitForOpen(ws, 3000);
            // Some connections: close immediately after open
            if (i % 3 === 0) {
              ws.close();
              return;
            }
            // Some connections: start Noise handshake but close mid-way
            if (i % 3 === 1) {
              const { NoiseClientTransport, computeKeyId } = await import(
                "./protocol-helpers"
              );
              const transport = new NoiseClientTransport({
                nodeId: daemon.nodeId,
                expectedKeyId: computeKeyId(daemon.noiseKeyInfo.publicKey),
                remoteStaticPubkey: daemon.noiseKeyInfo.publicKey,
                relayOrigin: "",
              });
              const clientHello = transport.getClientHello();
              ws.send(JSON.stringify(clientHello));
              // Close mid-handshake
              await Bun.sleep(50);
              ws.close();
              return;
            }
            // Some connections: complete handshake then close
            // Use a shorter timeout to avoid blocking if handshake fails
            try {
              const { NoiseClientTransport, computeKeyId } = await import(
                "./protocol-helpers"
              );
              const transport = new NoiseClientTransport({
                nodeId: daemon.nodeId,
                expectedKeyId: computeKeyId(daemon.noiseKeyInfo.publicKey),
                remoteStaticPubkey: daemon.noiseKeyInfo.publicKey,
                relayOrigin: "",
              });
              const clientHello = transport.getClientHello();
              ws.send(JSON.stringify(clientHello));

              // Wait briefly for server_hello
              const serverHello = await waitForMessage(
                ws,
                (m) => (m as Record<string, unknown>)?.["t"] === "server_hello",
                2000,
              );
              const noise1Msgs = transport.processMessage(serverHello);
              for (const msg of noise1Msgs) {
                ws.send(JSON.stringify(msg));
              }
              ws.close();
            } catch {
              ws.close();
            }
          } catch {
            // Connection may fail during storm — that's fine
            try {
              ws.close();
            } catch {}
          }
        })(),
      );
    }

    // Wait for all connect-disconnect cycles to finish
    await Promise.allSettled(promises);

    // Verify daemon is still responsive with a full Noise session
    const { ws: verifyWs, transport: verifyTransport } =
      await performNoiseHandshake(
        daemon.wsUrl,
        daemon.noiseKeyInfo,
        daemon.nodeId,
      );

    expect(verifyTransport.isSecure).toBe(true);

    const resp = await encryptedRpc(
      verifyTransport,
      verifyWs,
      "listSessions",
      { filters: {} },
    );
    expect(resp["error"]).toBeUndefined();
    expect(Array.isArray((resp["result"] as { sessions: unknown[] }).sessions)).toBe(true);

    verifyWs.close();
  }, 30_000);

  // ---- 5. Large RPC payload over Noise ----

  test("large RPC payload over Noise", async () => {
    const { ws, transport } = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Generate a prompt that is ~100KB
    const largePrompt = "X".repeat(100 * 1024);

    // Spawn with the large prompt — this exercises encrypt/decrypt with a big payload
    const spawnResp = await encryptedRpc(
      transport,
      ws,
      "spawn",
      {
        prompt: largePrompt,
        backend: "claude-code",
        mode: "background",
        projectPath: testRepo,
        title: "Large payload Noise test",
      },
      20_000,
    );

    expect(spawnResp["error"]).toBeUndefined();
    const session = spawnResp["result"] as Record<string, unknown>;
    expect(typeof session["id"]).toBe("string");
    expect((session["id"] as string).startsWith("sess-")).toBe(true);

    // Verify we can retrieve the session (proves the large payload round-tripped)
    const getResp = await encryptedRpc(transport, ws, "getSession", {
      id: session["id"],
    });

    expect(getResp["error"]).toBeUndefined();
    const fetched = getResp["result"] as Record<string, unknown>;
    expect(fetched["id"]).toBe(session["id"]);
    expect(fetched["backend"]).toBe("claude-code");

    // Verify the large prompt was stored correctly (now inline in SessionDetailResponse)
    expect(fetched["prompt"]).toBe(largePrompt);

    ws.close();
  }, 30_000);
});
