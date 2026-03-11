import { describe, test, expect, beforeEach } from "bun:test";
import { TerminalManager } from "./terminal-manager";

/** Minimal mock IPty for testing manager logic without real PTY */
function createMockPty() {
  const dataHandlers: Array<(data: string) => void> = [];
  return {
    onData(handler: (data: string) => void) {
      dataHandlers.push(handler);
      return { dispose() {} };
    },
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
    // Test helper: simulate output
    _emit(data: string) {
      for (const h of dataHandlers) h(data);
    },
  };
}

function createMockSpawn() {
  const lastPty = { current: null as ReturnType<typeof createMockPty> | null };
  const spawn = (_shell: string, _args: string[], _opts: any) => {
    const pty = createMockPty();
    lastPty.current = pty;
    return pty as any;
  };
  return { spawn, lastPty };
}

describe("TerminalManager", () => {
  let manager: TerminalManager;
  let mockSpawn: ReturnType<typeof createMockSpawn>;

  beforeEach(() => {
    mockSpawn = createMockSpawn();
    manager = new TerminalManager(mockSpawn.spawn as any);
  });

  test("open creates a terminal with correct defaults", () => {
    const term = manager.open("sess-abc");
    expect(term.id).toMatch(/^term-/);
    expect(term.sessionId).toBe("sess-abc");
    expect(term.cols).toBe(120);
    expect(term.rows).toBe(30);
    expect(term.history).toBe("");
    expect(term.createdAt).toBeTruthy();
  });

  test("open uses custom cols/rows", () => {
    const term = manager.open("sess-abc", { cols: 80, rows: 24 });
    expect(term.cols).toBe(80);
    expect(term.rows).toBe(24);
  });

  test("get returns terminal by id", () => {
    const term = manager.open("sess-abc");
    expect(manager.get(term.id)).toBe(term);
  });

  test("get returns null for unknown id", () => {
    expect(manager.get("term-nonexistent")).toBeNull();
  });

  test("listForSession returns terminals for a session", () => {
    manager.open("sess-aaa");
    manager.open("sess-aaa");
    manager.open("sess-bbb");

    const list = manager.listForSession("sess-aaa");
    expect(list).toHaveLength(2);
    expect(list.every((t) => t.sessionId === "sess-aaa")).toBe(true);
  });

  test("listForSession returns empty array for unknown session", () => {
    expect(manager.listForSession("sess-unknown")).toEqual([]);
  });

  test("write throws for non-existent terminal", () => {
    expect(() => manager.write("term-nope", "hello")).toThrow("Terminal not found: term-nope");
  });

  test("resize throws for non-existent terminal", () => {
    expect(() => manager.resize("term-nope", 80, 24)).toThrow("Terminal not found: term-nope");
  });

  test("resize updates cols and rows", () => {
    const term = manager.open("sess-abc");
    manager.resize(term.id, 200, 50);
    expect(term.cols).toBe(200);
    expect(term.rows).toBe(50);
  });

  test("close throws for non-existent terminal", () => {
    expect(() => manager.close("term-nope")).toThrow("Terminal not found: term-nope");
  });

  test("close removes terminal from manager", () => {
    const term = manager.open("sess-abc");
    manager.close(term.id);
    expect(manager.get(term.id)).toBeNull();
  });

  test("closeAll removes all terminals for a session", () => {
    const t1 = manager.open("sess-aaa");
    const t2 = manager.open("sess-aaa");
    const t3 = manager.open("sess-bbb");

    manager.closeAll("sess-aaa");

    expect(manager.get(t1.id)).toBeNull();
    expect(manager.get(t2.id)).toBeNull();
    expect(manager.get(t3.id)).not.toBeNull();
  });

  test("closeAll is a no-op for unknown session", () => {
    manager.open("sess-abc");
    manager.closeAll("sess-unknown");
    expect(manager.listForSession("sess-abc")).toHaveLength(1);
  });

  test("history captures PTY output", () => {
    const term = manager.open("sess-abc");
    const pty = mockSpawn.lastPty.current!;

    pty._emit("hello ");
    pty._emit("world");

    expect(term.history).toBe("hello world");
  });

  test("history buffer is capped at 100KB", () => {
    const term = manager.open("sess-abc");
    const pty = mockSpawn.lastPty.current!;

    // Emit 120KB of data
    const chunk = "x".repeat(1024);
    for (let i = 0; i < 120; i++) {
      pty._emit(chunk);
    }

    expect(term.history.length).toBeLessThanOrEqual(100 * 1024);
  });

  test("onData registers handler and receives data", () => {
    const term = manager.open("sess-abc");
    const pty = mockSpawn.lastPty.current!;

    const received: string[] = [];
    manager.onData(term.id, (data) => received.push(data));

    pty._emit("hello");
    pty._emit("world");

    expect(received).toEqual(["hello", "world"]);
  });

  test("onData throws for non-existent terminal", () => {
    expect(() => manager.onData("term-nope", () => {})).toThrow("Terminal not found: term-nope");
  });

  test("onData unsubscribe stops receiving data", () => {
    const term = manager.open("sess-abc");
    const pty = mockSpawn.lastPty.current!;

    const received: string[] = [];
    const unsub = manager.onData(term.id, (data) => received.push(data));

    pty._emit("before");
    unsub();
    pty._emit("after");

    expect(received).toEqual(["before"]);
  });

  test("multiple onData handlers all receive data", () => {
    const term = manager.open("sess-abc");
    const pty = mockSpawn.lastPty.current!;

    const r1: string[] = [];
    const r2: string[] = [];
    manager.onData(term.id, (data) => r1.push(data));
    manager.onData(term.id, (data) => r2.push(data));

    pty._emit("test");

    expect(r1).toEqual(["test"]);
    expect(r2).toEqual(["test"]);
  });

  test("close cleans up data handlers", () => {
    const term = manager.open("sess-abc");
    const received: string[] = [];
    manager.onData(term.id, (data) => received.push(data));

    manager.close(term.id);

    // After close, onData for this terminal should throw
    expect(() => manager.onData(term.id, () => {})).toThrow("Terminal not found");
  });

  test("constructor throws when no ptySpawn and node-pty unavailable", () => {
    // Without providing ptySpawn, the constructor tries require("node-pty")
    // which will fail in this test environment
    expect(() => new TerminalManager()).toThrow("node-pty is not available");
  });
});
