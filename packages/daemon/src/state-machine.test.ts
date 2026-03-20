import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrateDb, DatabaseRepository } from "./db";
import type { SessionStatus } from "@orka/core";

let testHome = "";
let db: DatabaseRepository;

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "orka-sm-test-"));
  const rawDb = openDb(testHome);
  await migrateDb(rawDb, testHome);
  db = new DatabaseRepository(rawDb);
});

afterEach(() => {
  db.close();
  rmSync(testHome, { recursive: true, force: true });
});

function seedSession(sessionId: string, status: SessionStatus): void {
  db.insertTask({
    id: `task-${sessionId}`,
    title: `Task ${sessionId}`,
    prompt: "test prompt",
    backend: "claude-code",
    model: "claude-sonnet",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  db.insertSession({
    id: sessionId,
    taskId: `task-${sessionId}`,
    workspaceId: "",
    status,
    backend: "claude-code",
    projectPath: "/tmp/project",
    workingDir: "/tmp/project",
    logFile: `/tmp/${sessionId}.log`,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: null,
    exitCode: null,
    kept: false,
    autoMerge: false,
  });
}

// The VALID_TRANSITIONS map from db.ts (mirrored here for test verification)
const VALID_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  queued: ["preparing", "cancelled"],
  preparing: ["running", "cancelled", "failed"],
  running: ["idle", "rate_limited", "completed", "failed", "cancelled", "interrupted"],
  idle: ["running", "hibernated", "completed", "failed", "cancelled", "interrupted"],
  rate_limited: ["running", "hibernated", "completed", "cancelled", "interrupted"],
  hibernated: ["running"],
  completed: ["running"],
  failed: ["running"],
  cancelled: ["running"],
  interrupted: ["running"],
};

describe("valid transitions succeed without warning", () => {
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    for (const to of targets) {
      test(`${from} → ${to}`, () => {
        const sessionId = `sess-${from}-${to}`;
        seedSession(sessionId, from as SessionStatus);

        const warnings: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
        try {
          db.updateSessionStatus(sessionId, to as SessionStatus);
          const updated = db.getSession(sessionId);
          expect(updated!.status).toBe(to);
          expect(warnings).toHaveLength(0);
        } finally {
          console.warn = origWarn;
        }
      });
    }
  }
});

describe("invalid transitions log warning", () => {
  // Generate some clearly invalid transitions
  const invalidCases: Array<[SessionStatus, SessionStatus]> = [
    ["failed", "idle"],
    ["failed", "completed"],
    ["cancelled", "idle"],
    ["cancelled", "completed"],
    ["completed", "idle"],
    ["completed", "failed"],
    ["queued", "running"], // must go through preparing
    ["queued", "idle"],
    ["hibernated", "completed"],
    ["hibernated", "idle"],
    ["interrupted", "idle"],
    ["interrupted", "completed"],
    ["preparing", "idle"],
    ["preparing", "completed"],
  ];

  for (const [from, to] of invalidCases) {
    test(`${from} → ${to} logs warning`, () => {
      const sessionId = `sess-inv-${from}-${to}`;
      seedSession(sessionId, from);

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
      try {
        db.updateSessionStatus(sessionId, to);
        // The update still applies (it's a warning, not a rejection)
        const updated = db.getSession(sessionId);
        expect(updated!.status).toBe(to);
        // But a warning was logged
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("[state-machine]");
        expect(warnings[0]).toContain(from);
        expect(warnings[0]).toContain(to);
      } finally {
        console.warn = origWarn;
      }
    });
  }
});

describe("resume paths (terminal → running)", () => {
  test("completed → running (resume)", () => {
    seedSession("sess-resume-comp", "completed");
    db.updateSessionStatus("sess-resume-comp", "running");
    expect(db.getSession("sess-resume-comp")!.status).toBe("running");
  });

  test("failed → running (resume after failure)", () => {
    seedSession("sess-resume-fail", "failed");
    db.updateSessionStatus("sess-resume-fail", "running");
    expect(db.getSession("sess-resume-fail")!.status).toBe("running");
  });

  test("cancelled → running (resume after cancellation)", () => {
    seedSession("sess-resume-cancel", "cancelled");
    db.updateSessionStatus("sess-resume-cancel", "running");
    expect(db.getSession("sess-resume-cancel")!.status).toBe("running");
  });

  test("interrupted → running (resume after interrupt)", () => {
    seedSession("sess-resume-int", "interrupted");
    db.updateSessionStatus("sess-resume-int", "running");
    expect(db.getSession("sess-resume-int")!.status).toBe("running");
  });
});

describe("early cancellation paths", () => {
  test("queued → cancelled", () => {
    seedSession("sess-q-cancel", "queued");
    db.updateSessionStatus("sess-q-cancel", "cancelled");
    expect(db.getSession("sess-q-cancel")!.status).toBe("cancelled");
  });

  test("preparing → cancelled", () => {
    seedSession("sess-p-cancel", "preparing");
    db.updateSessionStatus("sess-p-cancel", "cancelled");
    expect(db.getSession("sess-p-cancel")!.status).toBe("cancelled");
  });
});

describe("updateSessionStatus with extra fields", () => {
  test("sets startedAt and finishedAt alongside status", () => {
    seedSession("sess-extra", "running");
    db.updateSessionStatus("sess-extra", "completed", {
      finishedAt: "2026-01-01T00:05:00.000Z",
      exitCode: 0,
    });

    const session = db.getSession("sess-extra");
    expect(session!.status).toBe("completed");
    expect(session!.finishedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(session!.exitCode).toBe(0);
  });
});
