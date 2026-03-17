/**
 * Minimal shell-based ProviderAdapter for E2E tests.
 *
 * Registers under "claude-code" kind so tests can spawn sessions
 * without requiring the real claude CLI binary.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderApprovalDecision,
  RawProviderLine,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import { createEvent } from "@orka/core";

const CTRL_C = "\u0003";

type ShellProcess = ReturnType<typeof Bun.spawn>;

interface AsyncQueueResult<T> {
  done: boolean;
  value?: T;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: AsyncQueueResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ done: true });
    }
  }

  private async next(): Promise<AsyncQueueResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true };
    return new Promise<AsyncQueueResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const result = await this.next();
      if (result.done) return;
      yield result.value as T;
    }
  }
}

interface TestSessionRuntime {
  proc: ShellProcess;
  queue: AsyncEventQueue<ProviderRuntimeEvent>;
  rawEvents: AsyncEventQueue<RawProviderLine>;
  closed: boolean;
  exitEmitted: boolean;
}

/**
 * A test adapter that runs bash commands directly.
 * Registers as "claude-code" so it fits into the BackendKind type system.
 */
export class TestShellAdapter implements ProviderAdapter {
  readonly kind = "claude-code" as const;

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    const threadId = input.threadId;
    const cwd = input.cwd ?? process.cwd();
    const prompt = input.prompt ?? "";

    const orkaHome = process.env["ORKA_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".orka");
    const scriptsDir = join(orkaHome, "provider-scripts");
    const scriptPath = join(scriptsDir, `${threadId.replace(/[^a-zA-Z0-9_-]/g, "-")}.sh`);

    const lines = ["#!/usr/bin/env bash", "unset CLAUDECODE"];
    if (prompt.trim().length > 0) lines.push(prompt);
    lines.push('exec "${SHELL:-/bin/bash}" -i');

    await mkdir(scriptsDir, { recursive: true });
    await writeFile(scriptPath, `${lines.join("\n")}\n`, "utf8");

    const proc = Bun.spawn(["bash", scriptPath], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...input.env },
    });

    const rawEventsQueue = new AsyncEventQueue<RawProviderLine>();
    const runtime: TestSessionRuntime = {
      proc,
      queue: new AsyncEventQueue<ProviderRuntimeEvent>(),
      rawEvents: rawEventsQueue,
      closed: false,
      exitEmitted: false,
    };

    runtime.queue.push(
      createEvent("session.started", threadId, { message: `test session started (pid ${proc.pid})` }, { provider: this.kind }),
    );

    void this.streamOutput(threadId, runtime);

    return {
      threadId,
      provider: this.kind,
      events: runtime.queue,
      rawEvents: rawEventsQueue,
      meta: { scriptPath, runtime },
    };
  }

  async sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void> {
    if (input.input === undefined) return;
    const runtime = handle.meta["runtime"] as TestSessionRuntime;
    const text = `${input.input}\n`;
    runtime.proc.stdin.write(text);
    runtime.proc.stdin.flush();
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    const runtime = handle.meta["runtime"] as TestSessionRuntime;
    runtime.proc.stdin.write(CTRL_C);
    runtime.proc.stdin.flush();
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    const runtime = handle.meta["runtime"] as TestSessionRuntime;
    runtime.closed = true;
    runtime.proc.kill();
    this.emitSessionExited(handle.threadId, runtime, "stopped");
  }

  async respondToRequest(
    _handle: ProviderSessionHandle,
    _requestId: string,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {}

  private async streamOutput(threadId: string, runtime: TestSessionRuntime): Promise<void> {
    const decoder = new TextDecoder();

    const readStream = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      try {
        for await (const chunk of stream) {
          if (runtime.closed) return;
          const text = decoder.decode(chunk, { stream: true });
          if (text.length > 0) {
            runtime.rawEvents.push({ direction: "out", data: text, ts: new Date().toISOString() });
            runtime.queue.push(
              createEvent("content.delta", threadId, { streamKind: "command_output", delta: text }, { provider: this.kind }),
            );
          }
        }
      } catch {
        // Stream closed
      }
    };

    const stdoutDone = readStream(runtime.proc.stdout as ReadableStream<Uint8Array> | null);
    const stderrDone = readStream(runtime.proc.stderr as ReadableStream<Uint8Array> | null);

    const exitCode = await runtime.proc.exited;
    await Promise.allSettled([stdoutDone, stderrDone]);

    if (!runtime.closed) {
      this.emitSessionExited(threadId, runtime, "process exited");
    }
  }

  private emitSessionExited(threadId: string, runtime: TestSessionRuntime, reason: string): void {
    if (runtime.exitEmitted) return;
    runtime.exitEmitted = true;
    runtime.closed = true;
    runtime.queue.push(
      createEvent("session.exited", threadId, { reason, exitKind: "graceful" }, { provider: this.kind }),
    );
    runtime.queue.close();
    runtime.rawEvents.close();
  }
}

/**
 * Override the daemon context's adapter registry with the test adapter.
 * Call this after createDaemonContext() in E2E test setup.
 */
export function registerTestAdapter(ctx: { providerAdapterRegistry: { register(kind: "claude-code", adapter: ProviderAdapter): void } }): void {
  ctx.providerAdapterRegistry.register("claude-code", new TestShellAdapter());
}
