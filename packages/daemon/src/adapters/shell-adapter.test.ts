import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { RunnerSession, SessionRunner } from "../runner";
import { ShellAdapter } from "./shell-adapter";

class MockSessionRunner implements SessionRunner {
  readonly spawnCalls: Array<{ name: string; scriptPath: string; cwd: string }> = [];
  readonly killCalls: string[] = [];
  readonly sendKeysCalls: Array<{ name: string; keys: string }> = [];
  readonly sendTextCalls: Array<{ name: string; text: string }> = [];
  hasSequence: boolean[] = [];
  captureSequence: string[] = [];
  running = true;
  captureOutput = "";

  async spawn(name: string, scriptPath: string, cwd: string): Promise<void> {
    this.spawnCalls.push({ name, scriptPath, cwd });
    this.running = true;
  }

  async kill(name: string): Promise<void> {
    this.killCalls.push(name);
    this.running = false;
  }

  async has(_name: string): Promise<boolean> {
    return this.hasSequence.length > 0 ? this.hasSequence.shift() ?? false : this.running;
  }

  async list(): Promise<RunnerSession[]> {
    return [];
  }

  async capture(_name: string, _lines?: number): Promise<string> {
    return this.captureSequence.length > 0 ? this.captureSequence.shift() ?? "" : this.captureOutput;
  }

  async sendKeys(name: string, keys: string): Promise<void> {
    this.sendKeysCalls.push({ name, keys });
  }

  async sendText(name: string, text: string): Promise<void> {
    this.sendTextCalls.push({ name, text });
  }

  async attach(_name: string): Promise<void> {}
}

describe("ShellAdapter", () => {
  test("startSession emits session.started first", async () => {
    useTempOrkaHome("started");
    const runner = new MockSessionRunner();
    const adapter = new ShellAdapter(runner);
    const handle = await adapter.startSession({
      threadId: "thread-1",
      cwd: "/tmp/project",
      prompt: "echo ready",
    });

    const iterator = handle.events[Symbol.asyncIterator]();
    const started = await nextEvent(iterator);

    expect(started.type).toBe("session.started");
    expect(started.provider).toBe("shell");
    expect(runner.spawnCalls).toHaveLength(1);

    await adapter.stopSession(handle);
    await iterator.next();
  });

  test("startSession writes env exports into the shell script", async () => {
    useTempOrkaHome("env");
    const runner = new MockSessionRunner();
    const adapter = new ShellAdapter(runner);
    const handle = await adapter.startSession({
      threadId: "thread-env",
      cwd: "/tmp/project",
      prompt: "echo ready",
      env: { FOO: "bar baz" },
    });

    expect(runner.spawnCalls).toHaveLength(1);
    const script = readFileSync(runner.spawnCalls[0]!.scriptPath, "utf8");
    expect(script).toContain("export FOO='bar baz'");
    expect(script).toContain("unset CLAUDECODE");

    await adapter.stopSession(handle);
  });

  test("stopSession emits session.exited", async () => {
    useTempOrkaHome("stopped");
    const runner = new MockSessionRunner();
    const adapter = new ShellAdapter(runner);
    const handle = await adapter.startSession({ threadId: "thread-stop" });
    const iterator = handle.events[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).type).toBe("session.started");

    await adapter.stopSession(handle);

    const exited = await nextEvent(iterator);
    expect(exited.type).toBe("session.exited");
    expect(exited.payload).toEqual({ reason: "stopped", exitKind: "graceful" });
    expect(runner.killCalls).toEqual(["orka-shell-thread-stop"]);
  });

  test("events stream yields lifecycle events in order", async () => {
    useTempOrkaHome("order");
    const runner = new MockSessionRunner();
    runner.hasSequence = [true, false];
    runner.captureSequence = ["hello"];
    const adapter = new ShellAdapter(runner);
    const handle = await adapter.startSession({ threadId: "thread-order" });
    const iterator = handle.events[Symbol.asyncIterator]();

    const first = await nextEvent(iterator);
    const second = await nextEvent(iterator);
    const third = await nextEvent(iterator);

    expect([first.type, second.type, third.type]).toEqual([
      "session.started",
      "content.delta",
      "session.exited",
    ]);
    expect(second.payload).toEqual({ streamKind: "command_output", delta: "hello" });
  });

  test("interruptTurn sends ctrl-c without throwing", async () => {
    useTempOrkaHome("interrupt");
    const runner = new MockSessionRunner();
    const adapter = new ShellAdapter(runner);
    const handle = await adapter.startSession({ threadId: "thread-interrupt" });
    const iterator = handle.events[Symbol.asyncIterator]();

    await nextEvent(iterator);
    await expect(adapter.interruptTurn(handle)).resolves.toBeUndefined();

    expect(runner.sendKeysCalls).toEqual([{ name: "orka-shell-thread-interrupt", keys: "\u0003" }]);

    await adapter.stopSession(handle);
    await iterator.next();
  });
});

async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 2_000,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for event after ${timeoutMs}ms`)), timeoutMs);
  });
  const result = await Promise.race([iterator.next(), timeout]);
  if (result.done) {
    throw new Error("Event stream ended unexpectedly");
  }
  return result.value;
}

function useTempOrkaHome(suffix: string): void {
  process.env.ORKA_HOME = `/tmp/orka-shell-adapter-${suffix}-${Date.now()}`;
}
