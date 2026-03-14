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
import type { Span } from "@opentelemetry/api";
import { createEvent } from "@orka/core";
import { buildBackendCommand, buildEnvExports } from "../backends";
import { getOrkaHome } from "../db";
import { withSpan } from "../tracing";

const CTRL_C = "\u0003";

type ShellProcess = ReturnType<typeof Bun.spawn>;
type ShellSpawn = typeof Bun.spawn;

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
    if (value !== undefined) {
      return { done: false, value };
    }

    if (this.closed) {
      return { done: true };
    }

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

interface ShellSessionRuntime {
  proc: ShellProcess;
  scriptPath: string;
  queue: AsyncEventQueue<ProviderRuntimeEvent>;
  rawEvents: AsyncEventQueue<RawProviderLine>;
  closed: boolean;
  exitEmitted: boolean;
}

export class ShellAdapter implements ProviderAdapter {
  readonly kind = "shell" as const;

  constructor(private readonly spawnProcess: ShellSpawn = Bun.spawn.bind(Bun)) {}

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    return withSpan(
      "orka.provider.shell.start_session",
      {
        "orka.session.id": input.threadId,
        ...(input.cwd ? { "orka.cwd": input.cwd } : {}),
        ...(input.prompt ? { "orka.command": input.prompt } : {}),
      },
      async (span) => {
        const threadId = input.threadId;
        const cwd = input.cwd ?? process.cwd();
        const scriptsDir = join(getOrkaHome(), "provider-scripts");
        const scriptPath = join(scriptsDir, `${sanitizeName(threadId)}.sh`);
        const { command } = buildBackendCommand("shell", input.prompt ?? "", "interactive");

        await mkdir(scriptsDir, { recursive: true });
        await writeFile(scriptPath, buildScript(command, input.env), "utf8");

        const proc = this.spawnProcess(["bash", scriptPath], {
          cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        span.addEvent("process.spawned", { "orka.command": command });

        const rawEventsQueue = new AsyncEventQueue<RawProviderLine>();
        const runtime: ShellSessionRuntime = {
          proc,
          scriptPath,
          queue: new AsyncEventQueue<ProviderRuntimeEvent>(),
          rawEvents: rawEventsQueue,
          closed: false,
          exitEmitted: false,
        };

        emitShellEvent(
          runtime.queue,
          createEvent(
            "session.started",
            threadId,
            { message: `shell session started (pid ${proc.pid})` },
            { provider: this.kind },
          ),
          span,
        );

        void this.streamOutput(threadId, runtime);

        return {
          threadId,
          provider: this.kind,
          events: runtime.queue,
          rawEvents: rawEventsQueue,
          meta: {
            scriptPath,
            runtime,
          },
        };
      },
    );
  }

  async sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void> {
    await withSpan(
      "orka.provider.shell.send_turn",
      {
        "orka.session.id": handle.threadId,
        ...(input.model ? { "orka.model": input.model } : {}),
      },
      async () => {
        if (input.input === undefined) return;

        const runtime = getRuntime(handle);
        const text = `${input.input}\n`;
        runtime.proc.stdin.write(text);
        runtime.proc.stdin.flush();
      },
    );
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    await withSpan("orka.provider.shell.interrupt_turn", { "orka.session.id": handle.threadId }, async () => {
      const runtime = getRuntime(handle);
      runtime.proc.stdin.write(CTRL_C);
      runtime.proc.stdin.flush();
    });
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    await withSpan("orka.provider.shell.stop_session", { "orka.session.id": handle.threadId }, async (span) => {
      const runtime = getRuntime(handle);
      runtime.closed = true;

      runtime.proc.kill();

      span.addEvent("process.exited", { "orka.exit_code": -1 });
      this.emitSessionExited(handle.threadId, runtime, "stopped", "graceful", span);
    });
  }

  async respondToRequest(
    handle: ProviderSessionHandle,
    _requestId: string,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {
    await withSpan("orka.provider.shell.respond_to_request", { "orka.session.id": handle.threadId }, async () => {});
  }

  private async streamOutput(threadId: string, runtime: ShellSessionRuntime): Promise<void> {
    await withSpan(
      "orka.provider.shell.parse_output",
      { "orka.session.id": threadId, "orka.backend": this.kind },
      async (span) => {
        const decoder = new TextDecoder();

        const readStream = async (stream: ReadableStream<Uint8Array> | null) => {
          if (!stream) return;
          try {
            for await (const chunk of stream) {
              if (runtime.closed) return;
              const text = decoder.decode(chunk, { stream: true });
              if (text.length > 0) {
                runtime.rawEvents.push({ direction: "out", data: text, ts: new Date().toISOString() });
                emitShellEvent(
                  runtime.queue,
                  createEvent(
                    "content.delta",
                    threadId,
                    { streamKind: "command_output", delta: text },
                    { provider: this.kind },
                  ),
                  span,
                );
              }
            }
          } catch {
            // Stream closed — handled by proc.exited below
          }
        };

        // Read stdout and stderr concurrently, merging both into the event stream
        const stdoutDone = readStream(runtime.proc.stdout as ReadableStream<Uint8Array> | null);
        const stderrDone = readStream(runtime.proc.stderr as ReadableStream<Uint8Array> | null);

        // Wait for the process to exit
        const exitCode = await runtime.proc.exited;
        // Wait for streams to finish draining
        await Promise.allSettled([stdoutDone, stderrDone]);

        if (!runtime.closed) {
          span.addEvent("process.exited", { "orka.exit_code": exitCode });
          this.emitSessionExited(threadId, runtime, "process exited", "graceful", span);
        }
      },
    );
  }

  private emitSessionExited(
    threadId: string,
    runtime: ShellSessionRuntime,
    reason = "process exited",
    exitKind: "graceful" | "error" = "graceful",
    span?: Span,
  ): void {
    if (runtime.exitEmitted) return;

    runtime.exitEmitted = true;
    runtime.closed = true;
    emitShellEvent(
      runtime.queue,
      createEvent(
        "session.exited",
        threadId,
        { reason, exitKind },
        { provider: this.kind },
      ),
      span,
    );
    runtime.queue.close();
    runtime.rawEvents.close();
  }

  async *replayRawLog(threadId: string, lines: RawProviderLine[]): AsyncIterable<ProviderRuntimeEvent> {
    for (const line of lines) {
      if (line.direction !== "out") continue;
      yield createEvent(
        "content.delta",
        threadId,
        { streamKind: "command_output", delta: line.data },
        { provider: this.kind, createdAt: line.ts },
      );
    }
  }
}

function getRuntime(handle: ProviderSessionHandle): ShellSessionRuntime {
  const runtime = handle.meta["runtime"];
  if (!isShellSessionRuntime(runtime)) {
    throw new Error(`Invalid shell session handle for thread "${handle.threadId}"`);
  }

  return runtime;
}

function isShellSessionRuntime(value: unknown): value is ShellSessionRuntime {
  return typeof value === "object" && value !== null && "proc" in value && "queue" in value;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function emitShellEvent(queue: AsyncEventQueue<ProviderRuntimeEvent>, event: ProviderRuntimeEvent, span?: Span): void {
  queue.push(event);
  span?.addEvent("event.emitted", { "orka.event.type": event.type });
}

function buildScript(command: string, env?: Record<string, string>): string {
  const lines = ["#!/usr/bin/env bash", ...buildEnvExports(env), "unset CLAUDECODE"];
  if (command.trim().length > 0) {
    lines.push(command);
  }
  lines.push('exec "${SHELL:-/bin/bash}" -i');
  return `${lines.join("\n")}\n`;
}
