import type {
  ProviderAdapter,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import { createEvent } from "@orka/core";
import { withSpan } from "../tracing";

type CodexRpcMethod = "startSession" | "sendMessage" | "interrupt" | "stop";
type CodexProcess = ReturnType<typeof Bun.spawn>;

interface CodexHandleMeta {
  process: CodexProcess;
  writeRpc: (method: CodexRpcMethod, params?: unknown) => Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: CodexRpcMethod;
  params?: unknown;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;

    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return { value: this.values.shift() as T, done: false };
        }

        if (this.closed) {
          return { value: undefined as T, done: true };
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    return withSpan(
      "orka.provider.codex.start_session",
      { "orka.session.id": input.threadId, "orka.backend": this.kind },
      async () => {
        const command = ["codex", "app-server"];
        if (input.model) {
          command.push("--model", input.model);
        }

        const process = Bun.spawn(command, {
          cwd: input.cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

        const events = new AsyncEventQueue<ProviderRuntimeEvent>();
        const meta = this.createHandleMeta(input.threadId, process);
        const handle: ProviderSessionHandle = {
          threadId: input.threadId,
          provider: this.kind,
          events,
          meta: {
            process,
            writeRpc: meta.writeRpc,
          },
        };

        const stdout = process.stdout;
        if (!stdout) {
          events.push(
            createEvent(
              "runtime.error",
              input.threadId,
              { message: "Codex app-server stdout is not available", class: "transport_error" },
              { provider: this.kind },
            ),
          );
          events.push(
            createEvent(
              "session.exited",
              input.threadId,
              { reason: "Codex app-server failed to start stdout transport", exitKind: "error" },
              { provider: this.kind },
            ),
          );
          events.close();
          throw new Error("Codex app-server stdout is not available");
        }

        if (process.stderr) {
          void drainStream(process.stderr);
        }

        const outputTask = consumeCodexOutput(input.threadId, stdout, events);
        void finalizeCodexProcess(input.threadId, process, outputTask, events);

        try {
          await meta.writeRpc("startSession", {
            prompt: input.prompt ?? "",
            model: input.model,
            cwd: input.cwd,
          });
        } catch (error) {
          process.kill();
          await process.exited;
          throw error;
        }

        return handle;
      },
    );
  }

  async sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void> {
    await withSpan(
      "orka.provider.codex.send_turn",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getCodexHandleMeta(handle);
        await meta.writeRpc("sendMessage", {
          message: input.input ?? "",
        });
      },
    );
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    await withSpan(
      "orka.provider.codex.interrupt_turn",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getCodexHandleMeta(handle);
        await meta.writeRpc("interrupt");
      },
    );
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    await withSpan(
      "orka.provider.codex.stop_session",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getCodexHandleMeta(handle);

        try {
          await meta.writeRpc("stop");
        } catch {
          // Best-effort stop; the subprocess may have already exited.
        }

        const exited = await waitForExit(meta.process, 250);
        if (!exited) {
          meta.process.kill();
          await meta.process.exited;
        }
      },
    );
  }

  async respondToRequest(): Promise<void> {
    throw new Error("Codex adapter does not support approval requests");
  }

  private createHandleMeta(threadId: string, process: CodexProcess): CodexHandleMeta {
    let requestCount = 0;

    return {
      process,
      writeRpc: async (method, params) => {
        await withSpan(
          "orka.rpc.request",
          { "orka.session.id": threadId, "orka.method": method, "orka.backend": this.kind },
          async () => {
            if (!process.stdin) {
              throw new Error("Codex app-server stdin is not available");
            }

            const request: JsonRpcRequest = {
              jsonrpc: "2.0",
              id: `codex-rpc-${++requestCount}`,
              method,
            };

            if (params !== undefined) {
              request.params = params;
            }

            await Promise.resolve(process.stdin.write(`${JSON.stringify(request)}\n`));
          },
        );
      },
    };
  }
}

export function mapCodexEvent(threadId: string, raw: unknown): ProviderRuntimeEvent | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }

  switch (raw.type) {
    case "session.started":
      return createEvent("session.started", threadId, {}, { provider: "codex" });

    case "turn.started":
      if (typeof raw.turn_id !== "string") {
        return null;
      }

      return createEvent("turn.started", threadId, {}, { provider: "codex", turnId: raw.turn_id });

    case "message.delta":
      if (typeof raw.delta !== "string") {
        return null;
      }

      return createEvent(
        "content.delta",
        threadId,
        { streamKind: "assistant_text", delta: raw.delta },
        { provider: "codex" },
      );

    case "command.start":
      if (typeof raw.command !== "string") {
        return null;
      }

      return createEvent(
        "item.started",
        threadId,
        {
          itemType: "command_execution",
          status: "in_progress",
          title: raw.command,
          detail: raw.command,
        },
        { provider: "codex" },
      );

    case "command.output":
      if (typeof raw.output !== "string") {
        return null;
      }

      return createEvent(
        "content.delta",
        threadId,
        { streamKind: "command_output", delta: raw.output },
        { provider: "codex" },
      );

    case "turn.completed": {
      const usage = normalizeUsage(raw.usage);
      return createEvent(
        "turn.completed",
        threadId,
        {
          state: "completed",
          usage,
        },
        { provider: "codex" },
      );
    }

    case "session.ended":
      return createEvent(
        "session.exited",
        threadId,
        { reason: "Codex session ended", exitKind: "graceful" },
        { provider: "codex" },
      );

    default:
      return null;
  }
}

async function consumeCodexOutput(
  threadId: string,
  stdout: NonNullable<CodexProcess["stdout"]>,
  events: AsyncEventQueue<ProviderRuntimeEvent>,
): Promise<boolean> {
  let sawSessionExit = false;

  try {
    for await (const line of readLines(stdout)) {
      let raw: unknown;

      try {
        raw = JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown JSON parse failure";
        events.push(
          createEvent(
            "runtime.warning",
            threadId,
            { message: `Ignoring malformed Codex event: ${message}` },
            { provider: "codex" },
          ),
        );
        continue;
      }

      const mapped = mapCodexEvent(threadId, raw);
      if (!mapped) {
        continue;
      }

      if (mapped.type === "session.exited") {
        sawSessionExit = true;
      }

      events.push(mapped);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown stream failure";
    events.push(
      createEvent(
        "runtime.error",
        threadId,
        { message: `Codex app-server stream failed: ${message}`, class: "transport_error" },
        { provider: "codex" },
      ),
    );
  }

  return sawSessionExit;
}

async function finalizeCodexProcess(
  threadId: string,
  process: CodexProcess,
  outputTask: Promise<boolean>,
  events: AsyncEventQueue<ProviderRuntimeEvent>,
): Promise<void> {
  const [sawSessionExit, exitCode] = await Promise.all([outputTask, process.exited]);

  if (!sawSessionExit) {
    events.push(
      createEvent(
        "session.exited",
        threadId,
        {
          reason: `Codex app-server exited with code ${exitCode}`,
          exitKind: exitCode === 0 ? "graceful" : "error",
        },
        { provider: "codex" },
      ),
    );
  }

  events.close();
}

async function* readLines(stream: NonNullable<CodexProcess["stdout"]>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
        }
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine.length > 0) {
      yield finalLine;
    }
  } finally {
    reader.releaseLock();
  }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();

  try {
    while (true) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitForExit(process: CodexProcess, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    process.exited.finally(() => clearTimeout(timer));
  });
  const exited = process.exited.then(() => true);
  return Promise.race([exited, timeout]);
}

function normalizeUsage(raw: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(raw) || typeof raw.input_tokens !== "number" || typeof raw.output_tokens !== "number") {
    return undefined;
  }

  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
  };
}

function getCodexHandleMeta(handle: ProviderSessionHandle): CodexHandleMeta {
  const meta = handle.meta as Partial<CodexHandleMeta>;
  if (!meta.process || typeof meta.writeRpc !== "function") {
    throw new Error("Invalid Codex provider session handle");
  }

  return meta as CodexHandleMeta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
