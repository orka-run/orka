import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { openTestDb, type DatabaseRepository } from "./db";

let db: DatabaseRepository;

beforeAll(async () => {
  db = await openTestDb();
});

afterEach(() => db.clearAllData());
afterAll(() => db.close());

function seedSession(
  sessionId: string,
  opts?: { status?: string; workspaceId?: string },
): void {
  const taskId = `task-${sessionId}`;
  db.insertTask({
    id: taskId,
    title: `Task ${sessionId}`,
    prompt: "Fix issue",
    backend: "claude-code",
    model: "claude-sonnet",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  db.insertSession({
    id: sessionId,
    taskId,
    workspaceId: opts?.workspaceId ?? "",
    status: (opts?.status ?? "completed") as any,
    backend: "claude-code",
    projectPath: "/tmp/project",
    workingDir: "/tmp/project",
    logFile: `/tmp/${sessionId}.log`,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:02:00.000Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
  });
}

describe("workspace CRUD", () => {
  test("insertWorkspace + getWorkspace round-trip", () => {
    db.insertWorkspace({
      id: "ws-1",
      name: "My Workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: JSON.stringify({ defaults: { backend: "codex" } }),
      metadata: JSON.stringify({ color: "blue", pinned: true }),
    });

    const ws = db.getWorkspace("ws-1");
    expect(ws).not.toBeNull();
    expect(ws!.id).toBe("ws-1");
    expect(ws!.name).toBe("My Workspace");
    expect(ws!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(ws!.archivedAt).toBeNull();
    expect(ws!.settings).toEqual({ defaults: { backend: "codex" } });
    expect(ws!.metadata).toEqual({ color: "blue", pinned: true });
    expect(ws!.paths).toEqual([]);
    expect(ws!.sessionCount).toBe(0);
    expect(ws!.activeCount).toBe(0);
  });

  test("getWorkspace returns null for unknown id", () => {
    expect(db.getWorkspace("ws-nonexistent")).toBeNull();
  });

  test("insertWorkspace with null settings and metadata", () => {
    db.insertWorkspace({
      id: "ws-bare",
      name: "Bare",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const ws = db.getWorkspace("ws-bare");
    expect(ws!.settings).toBeNull();
    expect(ws!.metadata).toBeNull();
  });
});

describe("workspace paths", () => {
  test("addWorkspacePath + getWorkspacePaths round-trip", () => {
    db.insertWorkspace({
      id: "ws-paths",
      name: "Paths Test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    db.addWorkspacePath("ws-paths", "/home/user/project-a");
    db.addWorkspacePath("ws-paths", "/home/user/project-b");

    const paths = db.getWorkspacePaths("ws-paths");
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual({ nodeId: "", projectPath: "/home/user/project-a" });
    expect(paths).toContainEqual({ nodeId: "", projectPath: "/home/user/project-b" });
  });

  test("addWorkspacePath with nodeId", () => {
    db.insertWorkspace({
      id: "ws-node",
      name: "Node Test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    db.addWorkspacePath("ws-node", "/remote/project", "node-1");
    db.addWorkspacePath("ws-node", "/remote/project"); // local (no nodeId)

    const paths = db.getWorkspacePaths("ws-node");
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual({ nodeId: "node-1", projectPath: "/remote/project" });
    expect(paths).toContainEqual({ nodeId: "", projectPath: "/remote/project" });
  });

  test("addWorkspacePath is idempotent (INSERT OR IGNORE)", () => {
    db.insertWorkspace({
      id: "ws-idem",
      name: "Idempotent",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    db.addWorkspacePath("ws-idem", "/project");
    db.addWorkspacePath("ws-idem", "/project"); // duplicate

    const paths = db.getWorkspacePaths("ws-idem");
    expect(paths).toHaveLength(1);
  });

  test("removeWorkspacePath deletes the mapping", () => {
    db.insertWorkspace({
      id: "ws-rm",
      name: "Remove Test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    db.addWorkspacePath("ws-rm", "/a");
    db.addWorkspacePath("ws-rm", "/b");
    db.removeWorkspacePath("ws-rm", "/a");

    const paths = db.getWorkspacePaths("ws-rm");
    expect(paths).toHaveLength(1);
    expect(paths[0]!.projectPath).toBe("/b");
  });
});

describe("resolveWorkspaceForPath", () => {
  test("resolves local path to workspace", () => {
    db.insertWorkspace({
      id: "ws-resolve",
      name: "Resolve",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.addWorkspacePath("ws-resolve", "/home/user/myproject");

    expect(db.resolveWorkspaceForPath("/home/user/myproject")).toBe("ws-resolve");
  });

  test("returns null for unknown path", () => {
    expect(db.resolveWorkspaceForPath("/unknown/path")).toBeNull();
  });

  test("prefers node-specific match over local fallback", () => {
    db.insertWorkspace({
      id: "ws-local",
      name: "Local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.insertWorkspace({
      id: "ws-remote",
      name: "Remote",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.addWorkspacePath("ws-local", "/shared/project"); // local
    db.addWorkspacePath("ws-remote", "/shared/project", "node-1"); // node-specific

    // With nodeId → exact match wins
    expect(db.resolveWorkspaceForPath("/shared/project", "node-1")).toBe("ws-remote");
    // Without nodeId → local fallback
    expect(db.resolveWorkspaceForPath("/shared/project")).toBe("ws-local");
  });

  test("falls back to local when nodeId has no match", () => {
    db.insertWorkspace({
      id: "ws-fallback",
      name: "Fallback",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.addWorkspacePath("ws-fallback", "/project");

    // Request with a nodeId that has no mapping → falls back to local
    expect(db.resolveWorkspaceForPath("/project", "unknown-node")).toBe("ws-fallback");
  });
});

describe("listWorkspaces with session counts", () => {
  test("counts total and active sessions per workspace", () => {
    db.insertWorkspace({
      id: "ws-counts",
      name: "Counts",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    seedSession("sess-1", { status: "completed", workspaceId: "ws-counts" });
    seedSession("sess-2", { status: "running", workspaceId: "ws-counts" });
    seedSession("sess-3", { status: "idle", workspaceId: "ws-counts" });
    seedSession("sess-4", { status: "failed", workspaceId: "ws-counts" });

    const workspaces = db.listWorkspaces();
    expect(workspaces).toHaveLength(1);

    const ws = workspaces[0]!;
    expect(ws.sessionCount).toBe(4);
    expect(ws.activeCount).toBe(2); // running + idle
  });

  test("excludes archived workspaces by default", () => {
    db.insertWorkspace({
      id: "ws-active",
      name: "Active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.insertWorkspace({
      id: "ws-archived",
      name: "Archived",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.updateWorkspace("ws-archived", { archivedAt: "2026-01-15T00:00:00.000Z" });

    expect(db.listWorkspaces()).toHaveLength(1);
    expect(db.listWorkspaces()[0]!.id).toBe("ws-active");

    // With includeArchived
    expect(db.listWorkspaces(true)).toHaveLength(2);
  });

  test("workspace with zero sessions returns 0 counts", () => {
    db.insertWorkspace({
      id: "ws-empty",
      name: "Empty",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const ws = db.getWorkspace("ws-empty");
    expect(ws!.sessionCount).toBe(0);
    expect(ws!.activeCount).toBe(0);
  });

  test("deleteWorkspace unlinks sessions", () => {
    db.insertWorkspace({
      id: "ws-del",
      name: "ToDelete",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    seedSession("sess-linked", { workspaceId: "ws-del" });

    db.deleteWorkspace("ws-del");

    expect(db.getWorkspace("ws-del")).toBeNull();
    const session = db.getSession("sess-linked");
    expect(session!.workspaceId).toBe("");
  });
});
