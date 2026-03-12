import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import type { Span } from "@opentelemetry/api";
import { createEvent } from "@orka/core";
import { buildBackendCommand, buildEnvExports } from "../backends";
import { getOrkaHome } from "../db";
import type { SessionRunner } from "../runner";
import { withSpan } from "../tracing";

const POLL_INTERVAL_MS = 500;
const CAPTURE_LINES = 1000;
const CTRL_C = "\u0003";

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
  sessionName: string;
  scriptPath: string;
  queue: AsyncEventQueue<ProviderRuntimeEvent>;
  closed: boolean;
  exitEmitted: boolean;
  lastCapture: string;
}

export class ShellAdapter implements ProviderAdapter {
  readonly kind = "shell" as const;

  constructor(private runner: SessionRunner) {}

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
        const sessionName = buildSessionName(threadId);
        const cwd = input.cwd ?? process.cwd();
        const scriptsDir = join(getOrkaHome(), "provider-scripts");
        const scriptPath = join(scriptsDir, `${sanitizeName(threadId)}.sh`);
        const { command } = buildBackendCommand("shell", input.prompt ?? "", "interactive");

        await mkdir(scriptsDir, { recursive: true });
        await writeFile(scriptPath, buildScript(command, input.env), "utf8");

        await this.runner.spawn(sessionName, scriptPath, cwd);
        span.addEvent("process.spawned", { "orka.command": command });

        const runtime: ShellSessionRuntime = {
          sessionName,
          scriptPath,
          queue: new AsyncEventQueue<ProviderRuntimeEvent>(),
          closed: false,
          exitEmitted: false,
          lastCapture: "",
        };

        emitShellEvent(
          runtime.queue,
          createEvent(
            "session.started",
            threadId,
            { message: `shell session started in tmux (${sessionName})` },
            { provider: this.kind },
          ),
          span,
        );

        void this.pollSession(threadId, runtime);

        return {
          threadId,
          provider: this.kind,
          events: runtime.queue,
          meta: {
            sessionName,
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
        await this.runner.sendText(runtime.sessionName, input.input);
      },
    );
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    await withSpan("orka.provider.shell.interrupt_turn", { "orka.session.id": handle.threadId }, async () => {
      const runtime = getRuntime(handle);
      await this.runner.sendKeys(runtime.sessionName, CTRL_C);
    });
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    await withSpan("orka.provider.shell.stop_session", { "orka.session.id": handle.threadId }, async (span) => {
      const runtime = getRuntime(handle);
      runtime.closed = true;

      if (await this.runner.has(runtime.sessionName)) {
        await this.runner.kill(runtime.sessionName);
      }

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

  private async pollSession(threadId: string, runtime: ShellSessionRuntime): Promise<void> {
    await withSpan(
      "orka.provider.shell.parse_output",
      { "orka.session.id": threadId, "orka.backend": this.kind },
      async (span) => {
        while (!runtime.closed) {
          try {
            const running = await this.runner.has(runtime.sessionName);
            if (!running) {
              span.addEvent("process.exited", { "orka.exit_code": -1 });
              this.emitSessionExited(threadId, runtime, "process exited", "graceful", span);
              return;
            }

            const capture = await this.runner.capture(runtime.sessionName, CAPTURE_LINES);
            const delta = diffCapture(runtime.lastCapture, capture);
            runtime.lastCapture = capture;

            if (delta.length > 0) {
              emitShellEvent(
                runtime.queue,
                createEvent(
                  "content.delta",
                  threadId,
                  { streamKind: "command_output", delta },
                  { provider: this.kind },
                ),
                span,
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emitShellEvent(
              runtime.queue,
              createEvent(
                "runtime.error",
                threadId,
                { message, class: "provider_error" },
                { provider: this.kind },
              ),
              span,
            );
            this.emitSessionExited(threadId, runtime, "polling failed", "error", span);
            return;
          }

          await sleep(POLL_INTERVAL_MS);
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
  return typeof value === "object" && value !== null && "sessionName" in value && "queue" in value;
}

function buildSessionName(threadId: string): string {
  return `orka-shell-${sanitizeName(threadId)}`;
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

function diffCapture(previous: string, current: string): string {
  if (current === previous) return "";
  if (current.startsWith(previous)) return current.slice(previous.length);

  const overlap = Math.min(previous.length, current.length);
  for (let size = overlap; size > 0; size--) {
    if (previous.endsWith(current.slice(0, size))) {
      return current.slice(size);
    }
  }

  return current;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
