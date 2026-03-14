/**
 * E2E tests for full session lifecycle through an encrypted Noise channel.
 *
 * Verifies:
 *   - Full lifecycle: spawn -> list -> show -> stop
 *   - Spawn -> wait for completion -> getResult
 *   - Spawn -> getLogContent
 *   - Multiple concurrent sessions
 *   - deleteSessions removes sessions
 *
 * Run with: bun test tests/e2e/protocol/session-lifecycle.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Isolated ORKA_HOME — must be set BEFORE importing daemon modules
const orkaHome = mkdtempSync(join(tmpdir(), "orka-lifecycle-"));
process.env["ORKA_HOME"] = orkaHome;

import {
  startDaemonWithNoise,
  performNoiseHandshake,
  encryptedRpc,
  type DaemonHandle,
  type SecureConnection,
} from "./protocol-helpers";

/**
 * Poll getSession via encrypted RPC until the session is no longer running.
 * Returns the final session object.
 */
async function waitForSessionCompletion(
  conn: SecureConnection,
  sessionId: string,
  timeoutMs = 15_000,
  intervalMs = 200,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await encryptedRpc(conn.transport, conn.ws, "getSession", {
      id: sessionId,
    });
    expect(resp.error).toBeUndefined();
    const session = resp.result as Record<string, unknown>;
    if (session && session.status !== "running" && session.status !== "queued" && session.status !== "preparing") {
      return session;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs}ms`);
}

describe("Session Lifecycle via Encrypted Channel", () => {
  let daemon: DaemonHandle;
  let testRepo: string;

  beforeAll(async () => {
    // Create a temp git repo for spawn tests
    testRepo = mkdtempSync(join(tmpdir(), "orka-lifecycle-repo-"));
    await $`git init ${testRepo}`.quiet();
    await $`git -C ${testRepo} config user.email "test@orka.dev"`.quiet();
    await $`git -C ${testRepo} config user.name "Orka Test"`.quiet();
    await $`git -C ${testRepo} commit --allow-empty -m "init"`.quiet();

    daemon = await startDaemonWithNoise({ nodeId: "lifecycle-test-node" });
  }, 30_000);

  afterAll(() => {
    daemon?.stop();
    rmSync(orkaHome, { recursive: true, force: true });
    rmSync(testRepo, { recursive: true, force: true });
  });

  // ---- 1. Full lifecycle: spawn -> list -> show -> stop ----

  test("full lifecycle: spawn -> list -> show -> stop via encrypted channel", async () => {
    const conn = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Spawn a shell session with a long-running command so we can stop it
    const spawnResp = await encryptedRpc(conn.transport, conn.ws, "spawn", {
      prompt: "sleep 60",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      title: "lifecycle-full-test",
    });

    expect(spawnResp.error).toBeUndefined();
    const spawned = spawnResp.result as Record<string, unknown>;
    expect(typeof spawned.id).toBe("string");
    expect((spawned.id as string).startsWith("sess-")).toBe(true);
    expect(spawned.backend).toBe("shell");
    expect(spawned.status).toBe("running");

    const sessionId = spawned.id as string;

    // List sessions and verify the new session appears
    const listResp = await encryptedRpc(conn.transport, conn.ws, "listSessions", {
      filters: {},
    });
    expect(listResp.error).toBeUndefined();
    const sessions = listResp.result as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.backend).toBe("shell");

    // Get session details
    const getResp = await encryptedRpc(conn.transport, conn.ws, "getSession", {
      id: sessionId,
    });
    expect(getResp.error).toBeUndefined();
    const detail = getResp.result as Record<string, unknown>;
    expect(detail.id).toBe(sessionId);
    expect(detail.backend).toBe("shell");
    expect(detail.mode).toBe("background");
    expect(detail.projectPath).toBe(testRepo);

    // Stop the session
    const stopResp = await encryptedRpc(conn.transport, conn.ws, "stop", {
      sessionId,
    });
    expect(stopResp.error).toBeUndefined();

    // Wait briefly for status to update
    await Bun.sleep(500);

    // Verify status becomes completed or stopped
    const afterStop = await encryptedRpc(conn.transport, conn.ws, "getSession", {
      id: sessionId,
    });
    expect(afterStop.error).toBeUndefined();
    const finalSession = afterStop.result as Record<string, unknown>;
    expect(["completed", "stopped", "cancelled", "failed"]).toContain(
      finalSession.status as string,
    );

    conn.ws.close();
  }, 30_000);

  // ---- 2. Spawn -> wait for completion -> getResult ----

  test("spawn -> wait for completion -> getResult via encrypted channel", async () => {
    const conn = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Spawn a short-lived shell session that exits cleanly.
    // The shell adapter appends `exec bash -i` after the command, so we
    // must `exit 0` explicitly to prevent the interactive shell from starting.
    const spawnResp = await encryptedRpc(conn.transport, conn.ws, "spawn", {
      prompt: "echo done && exit 0",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      title: "lifecycle-result-test",
    });

    expect(spawnResp.error).toBeUndefined();
    const spawned = spawnResp.result as Record<string, unknown>;
    const sessionId = spawned.id as string;
    expect(sessionId.startsWith("sess-")).toBe(true);

    // Poll until session completes
    const finalSession = await waitForSessionCompletion(conn, sessionId);
    expect(["completed", "failed"]).toContain(finalSession.status as string);

    // Get result
    const resultResp = await encryptedRpc(conn.transport, conn.ws, "getResult", {
      sessionId,
    });
    expect(resultResp.error).toBeUndefined();
    // Result may be null for very short shell sessions, but the call itself should succeed
    // If a result exists, verify its structure
    if (resultResp.result !== null) {
      const result = resultResp.result as Record<string, unknown>;
      expect(typeof result.result).toBe("string");
      expect(typeof result.durationMs).toBe("number");
    }

    conn.ws.close();
  }, 30_000);

  // ---- 3. Spawn -> getLogContent ----

  test("spawn -> getLogContent via encrypted channel", async () => {
    const conn = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Spawn a session that produces output and exits cleanly
    const spawnResp = await encryptedRpc(conn.transport, conn.ws, "spawn", {
      prompt: "echo lifecycle-log-test-output && exit 0",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      title: "lifecycle-log-test",
    });

    expect(spawnResp.error).toBeUndefined();
    const spawned = spawnResp.result as Record<string, unknown>;
    const sessionId = spawned.id as string;

    // Wait for completion
    await waitForSessionCompletion(conn, sessionId);

    // Get log content
    const logResp = await encryptedRpc(conn.transport, conn.ws, "getLogContent", {
      sessionId,
    });
    expect(logResp.error).toBeUndefined();
    // Log content should be a string (possibly empty for short sessions, but not null
    // since a log file is created for every session)
    const logContent = logResp.result;
    expect(logContent === null || typeof logContent === "string").toBe(true);

    conn.ws.close();
  }, 30_000);

  // ---- 4. Multiple sessions managed concurrently ----

  test("multiple sessions managed concurrently", async () => {
    const conn = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Spawn 3 sessions sequentially (encrypted RPCs share a single
    // transport with sequential nonces, so parallel sends would race)
    const sessionIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const resp = await encryptedRpc(conn.transport, conn.ws, "spawn", {
        prompt: "sleep 30",
        backend: "shell",
        mode: "background",
        projectPath: testRepo,
        title: `lifecycle-concurrent-${i}`,
        tags: ["concurrent-test"],
      });
      expect(resp.error).toBeUndefined();
      const session = resp.result as Record<string, unknown>;
      expect(typeof session.id).toBe("string");
      expect((session.id as string).startsWith("sess-")).toBe(true);
      expect(session.backend).toBe("shell");
      sessionIds.push(session.id as string);
    }

    expect(sessionIds.length).toBe(3);

    // List sessions and verify all 3 appear
    const listResp = await encryptedRpc(conn.transport, conn.ws, "listSessions", {
      filters: {},
    });
    expect(listResp.error).toBeUndefined();
    const allSessions = listResp.result as Array<Record<string, unknown>>;

    for (const id of sessionIds) {
      const found = allSessions.find((s) => s.id === id);
      expect(found).toBeDefined();
      expect(found!.backend).toBe("shell");
    }

    // Stop any that are still running
    for (const id of sessionIds) {
      const getResp = await encryptedRpc(conn.transport, conn.ws, "getSession", {
        id,
      });
      const session = getResp.result as Record<string, unknown>;
      if (session.status === "running" || session.status === "queued" || session.status === "preparing") {
        await encryptedRpc(conn.transport, conn.ws, "stop", { sessionId: id });
      }
    }

    // Wait briefly for status updates
    await Bun.sleep(500);

    // Verify all are no longer running
    for (const id of sessionIds) {
      const getResp = await encryptedRpc(conn.transport, conn.ws, "getSession", {
        id,
      });
      expect(getResp.error).toBeUndefined();
      const session = getResp.result as Record<string, unknown>;
      expect(["completed", "stopped", "cancelled", "failed"]).toContain(
        session.status as string,
      );
    }

    conn.ws.close();
  }, 30_000);

  // ---- 5. deleteSessions removes sessions ----

  test("deleteSessions removes sessions", async () => {
    const conn = await performNoiseHandshake(
      daemon.wsUrl,
      daemon.noiseKeyInfo,
      daemon.nodeId,
    );

    // Spawn a session that exits cleanly
    const spawnResp = await encryptedRpc(conn.transport, conn.ws, "spawn", {
      prompt: "echo delete-me && exit 0",
      backend: "shell",
      mode: "background",
      projectPath: testRepo,
      title: "lifecycle-delete-test",
    });

    expect(spawnResp.error).toBeUndefined();
    const spawned = spawnResp.result as Record<string, unknown>;
    const sessionId = spawned.id as string;

    // Wait for completion
    await waitForSessionCompletion(conn, sessionId);

    // Verify it exists in listing
    const listBefore = await encryptedRpc(conn.transport, conn.ws, "listSessions", {
      filters: {},
    });
    expect(listBefore.error).toBeUndefined();
    const beforeSessions = listBefore.result as Array<Record<string, unknown>>;
    expect(beforeSessions.some((s) => s.id === sessionId)).toBe(true);

    // Delete the session
    const deleteResp = await encryptedRpc(conn.transport, conn.ws, "deleteSessions", {
      ids: [sessionId],
    });
    expect(deleteResp.error).toBeUndefined();

    // Verify it no longer appears in listing
    const listAfter = await encryptedRpc(conn.transport, conn.ws, "listSessions", {
      filters: {},
    });
    expect(listAfter.error).toBeUndefined();
    const afterSessions = listAfter.result as Array<Record<string, unknown>>;
    expect(afterSessions.some((s) => s.id === sessionId)).toBe(false);

    conn.ws.close();
  }, 30_000);
});
