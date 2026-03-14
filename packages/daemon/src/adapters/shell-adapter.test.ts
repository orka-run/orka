import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { ShellAdapter } from "./shell-adapter";

type ShellProcess = ReturnType<typeof Bun.spawn>;
type ShellSpawn = typeof Bun.spawn;

function createMockProcess(opts?: {
  stdout?: string;
  exitCode?: number;
}): { proc: ShellProcess; stdin: { written: string[]; flushed: number }; resolve: () => void } {
  const stdoutText = opts?.stdout ?? "";
  const exitCode = opts?.exitCode ?? 0;

  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdoutText) {
        controller.enqueue(new TextEncoder().encode(stdoutText));
      }
      controller.close();
    },
  });

  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  const stdinTracker = { written: [] as string[], flushed: 0 };
  let resolveExited: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolveExited = r;
  });

  const proc = {
    pid: 12345,
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: {
      write(data: string) {
        stdinTracker.written.push(data);
      },
      flush() {
        stdinTracker.flushed++;
      },
      end() {},
    },
    exited: exitedPromise,
    killed: false,
    kill() {
      this.killed = true;
      resolveExited(exitCode);
    },
    unref() {},
    ref() {},
  } as unknown as ShellProcess;

  return {
    proc,
    stdin: stdinTracker,
    resolve: () => resolveExited(exitCode),
  };
}

function createMockSpawn(mockProc: ShellProcess): ShellSpawn {
  return ((_cmd: string[], _opts?: unknown) => {
    return mockProc;
  }) as unknown as ShellSpawn;
}

describe("ShellAdapter", () => {
  test("startSession emits session.started first", async () => {
    useTempOrkaHome("started");
    const { proc, resolve } = createMockProcess();
    const adapter = new ShellAdapter(createMockSpawn(proc));
    const handle = await adapter.startSession({
      threadId: "thread-1",
      cwd: "/tmp/project",
      prompt: "echo ready",
    });

    const iterator = handle.events[Symbol.asyncIterator]();
    const started = await nextEvent(iterator);

    expect(started.type).toBe("session.started");
    expect(started.provider).toBe("shell");

    await adapter.stopSession(handle);
    await iterator.next();
  });

  test("startSession writes env exports into the shell script", async () => {
    useTempOrkaHome("env");
    let spawnedArgs: [string[], unknown] | null = null;
    const { proc } = createMockProcess();
    const mockSpawn = ((cmd: string[], opts?: unknown) => {
      spawnedArgs = [cmd, opts];
      return proc;
    }) as unknown as ShellSpawn;

    const adapter = new ShellAdapter(mockSpawn);
    const handle = await adapter.startSession({
      threadId: "thread-env",
      cwd: "/tmp/project",
      prompt: "echo ready",
      env: { FOO: "bar baz" },
    });

    expect(spawnedArgs).not.toBeNull();
    const scriptPath = spawnedArgs![0][1];
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("export FOO='bar baz'");
    expect(script).toContain("unset CLAUDECODE");

    await adapter.stopSession(handle);
  });

  test("stopSession emits session.exited", async () => {
    useTempOrkaHome("stopped");
    const { proc } = createMockProcess();
    const adapter = new ShellAdapter(createMockSpawn(proc));
    const handle = await adapter.startSession({ threadId: "thread-stop" });
    const iterator = handle.events[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).type).toBe("session.started");

    await adapter.stopSession(handle);

    const exited = await nextEvent(iterator);
    expect(exited.type).toBe("session.exited");
    expect(exited.payload).toEqual({ reason: "stopped", exitKind: "graceful" });
  });

  test("events stream yields lifecycle events in order", async () => {
    useTempOrkaHome("order");
    const { proc, resolve } = createMockProcess({ stdout: "hello" });
    const adapter = new ShellAdapter(createMockSpawn(proc));
    const handle = await adapter.startSession({ threadId: "thread-order" });
    const iterator = handle.events[Symbol.asyncIterator]();

    // Process exits naturally after stdout is consumed
    resolve();

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

  test("interruptTurn writes ctrl-c to stdin", async () => {
    useTempOrkaHome("interrupt");
    const { proc, stdin } = createMockProcess();
    const adapter = new ShellAdapter(createMockSpawn(proc));
    const handle = await adapter.startSession({ threadId: "thread-interrupt" });
    const iterator = handle.events[Symbol.asyncIterator]();

    await nextEvent(iterator);
    await expect(adapter.interruptTurn(handle)).resolves.toBeUndefined();

    expect(stdin.written).toEqual(["\u0003"]);
    expect(stdin.flushed).toBe(1);

    await adapter.stopSession(handle);
    await iterator.next();
  });

  test("sendTurn writes input followed by newline to stdin", async () => {
    useTempOrkaHome("send");
    const { proc, stdin } = createMockProcess();
    const adapter = new ShellAdapter(createMockSpawn(proc));
    const handle = await adapter.startSession({ threadId: "thread-send" });
    const iterator = handle.events[Symbol.asyncIterator]();

    await nextEvent(iterator);
    await adapter.sendTurn(handle, { input: "ls -la" });

    expect(stdin.written).toEqual(["ls -la\n"]);
    expect(stdin.flushed).toBe(1);

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
  process.env["ORKA_HOME"] = `/tmp/orka-shell-adapter-${suffix}-${Date.now()}`;
}
