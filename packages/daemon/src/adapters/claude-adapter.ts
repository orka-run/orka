import type {
  ProviderAdapter,
  ProviderApprovalDecision,
  ReasoningEffort,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import type { Span } from "@opentelemetry/api";
import { createEvent, generateId } from "@orka/core";
import { withSpan } from "../tracing";

type ClaudeProcess = ReturnType<typeof Bun.spawn>;
type ClaudeSpawn = typeof Bun.spawn;
type ClaudeMapMode = "primary" | "exit";

interface ClaudeMapOptions {
  mode?: ClaudeMapMode;
  turnId?: string;
}

interface ClaudeHandleMeta {
  process: ClaudeProcess;
  events: AsyncEventQueue<ProviderRuntimeEvent>;
  exitEmitted: boolean;
  closed: boolean;
  turnId: string;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

function isWritableSink<T>(value: T): value is Exclude<T, number> {
  return typeof value !== "number";
}

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
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

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly kind = "claude-code" as const;

  constructor(private readonly spawnProcess: ClaudeSpawn = Bun.spawn.bind(Bun)) {}

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    return withSpan(
      "orka.provider.claude_code.start_session",
      { "orka.session.id": input.threadId, "orka.backend": this.kind },
      async (span) => {
        const events = new AsyncEventQueue<ProviderRuntimeEvent>();
        const turnId = generateId("turn");
        const command = buildClaudeCommand(input);
        // Remove CLAUDECODE env to prevent nested session detection
        const spawnEnv = { ...globalThis.process.env };
        delete spawnEnv.CLAUDECODE;

        const process = this.spawnProcess(command, {
          cwd: input.cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: spawnEnv,
        });
        span.addEvent("process.spawned", { "orka.command": command.join(" ") });
        const meta: ClaudeHandleMeta = {
          process,
          events,
          exitEmitted: false,
          closed: false,
          turnId,
        };

        const handle: ProviderSessionHandle = {
          threadId: input.threadId,
          provider: this.kind,
          events,
          meta: meta as unknown as Record<string, unknown>,
        };

        const stdout = process.stdout;
        const stdin = process.stdin;
        if (!isReadableStream(stdout) || !isWritableSink(stdin)) {
          emitClaudeEvent(
            events,
            createEvent(
              "runtime.error",
              input.threadId,
              { message: "Claude Code stdio is not available", class: "transport_error" },
              { provider: this.kind },
            ),
            span,
          );
          emitSessionExited(input.threadId, meta, "Claude Code failed to initialize stdio", "error", span);
          closeEvents(meta);
          throw new Error("Claude Code stdio is not available");
        }

        if (isReadableStream(process.stderr)) {
          void drainStream(process.stderr);
        }

        void consumeClaudeOutput(input.threadId, stdout, meta, process, input.model);

        try {
          if (input.prompt) {
            await Promise.resolve(stdin.write(input.prompt));
          }
          await Promise.resolve(stdin.end());
        } catch (error) {
          emitSessionExited(input.threadId, meta, "Claude Code prompt write failed", "error", span);
          closeEvents(meta);
          process.kill();
          await process.exited;
          throw error;
        }

        return handle;
      },
    );
  }

  async sendTurn(_handle: ProviderSessionHandle, _input: ProviderSendTurnInput): Promise<void> {
    throw new Error("Claude Code -p mode does not support multi-turn. Start a new session.");
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    await withSpan(
      "orka.provider.claude_code.interrupt_turn",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getClaudeHandleMeta(handle);
        meta.process.kill("SIGINT");
      },
    );
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    await withSpan(
      "orka.provider.claude_code.stop_session",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getClaudeHandleMeta(handle);

        emitSessionExited(handle.threadId, meta, "stopped", "graceful");
        closeEvents(meta);

        meta.process.kill("SIGINT");
        const exited = await waitForExit(meta.process, 250);
        if (!exited) {
          meta.process.kill();
          await meta.process.exited;
        }
      },
    );
  }

  async respondToRequest(
    _handle: ProviderSessionHandle,
    _requestId: string,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {
    throw new Error("Claude Code -p mode uses --permission-mode auto");
  }
}

export function mapClaudeEvent(
  threadId: string,
  raw: unknown,
  modeOrOptions: ClaudeMapMode | ClaudeMapOptions = "primary",
): ProviderRuntimeEvent | null {
  const { mode, turnId } = normalizeClaudeMapOptions(modeOrOptions);

  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }

  if (mode === "exit" && raw.type !== "result") {
    return null;
  }

  if (raw.type === "result") {
    if (mode === "exit") {
      return createEvent(
        "session.exited",
        threadId,
        {
          reason: typeof raw.subtype === "string" ? `Claude Code result: ${raw.subtype}` : "Claude Code completed",
          exitKind: raw.is_error === true ? "error" : "graceful",
        },
        { provider: "claude-code" },
      );
    }

    const usage = normalizeClaudeUsage(raw);
    return createEvent(
      "turn.completed",
      threadId,
      {
        state: raw.is_error === true ? "failed" : "completed",
        ...(typeof raw.subtype === "string" ? { stopReason: raw.subtype } : {}),
        ...(typeof raw.total_cost_usd === "number" ? { totalCostUsd: raw.total_cost_usd } : {}),
        ...(usage ? { usage } : {}),
      },
      { provider: "claude-code", turnId },
    );
  }

  switch (raw.type) {
    case "system":
      if (raw.subtype !== "init") {
        return null;
      }

      return createEvent(
        "session.started",
        threadId,
        { ...(typeof raw.message === "string" ? { message: raw.message } : {}) },
        { provider: "claude-code" },
      );

    case "assistant": {
      const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
      const toolUse = findClaudeToolUse(content);
      if (toolUse) {
        return createEvent(
          "item.started",
          threadId,
          {
            itemType: mapClaudeToolItemType(toolUse.name),
            status: "in_progress",
            title: formatClaudeToolTitle(toolUse.name, toolUse.input),
            detail: formatClaudeToolDetail(toolUse.name, toolUse.input),
          },
          { provider: "claude-code", turnId, itemId: toolUse.id },
        );
      }

      const text = extractClaudeAssistantText(content);
      if (!text) {
        return null;
      }

      return createEvent(
        "content.delta",
        threadId,
        { streamKind: "assistant_text", delta: text },
        { provider: "claude-code", turnId },
      );
    }

    case "tool": {
      const detail = extractClaudeText(raw.content);
      return createEvent(
        "item.completed",
        threadId,
        {
          itemType: "unknown",
          status: "completed",
          ...(detail ? { detail } : {}),
        },
        { provider: "claude-code", turnId, itemId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined },
      );
    }

    default:
      return null;
  }
}

async function consumeClaudeOutput(
  threadId: string,
  stdout: ReadableStream<Uint8Array>,
  meta: ClaudeHandleMeta,
  process: ClaudeProcess,
  model?: string,
): Promise<boolean> {
  return withSpan(
    "orka.provider.claude_code.parse_output",
    { "orka.session.id": threadId, "orka.backend": "claude-code" },
    async (span) => {
      let sawSessionExit = false;
      let emittedTurnStarted = false;

      try {
        for await (const line of readLines(stdout)) {
          let raw: unknown;

          try {
            raw = JSON.parse(line);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown JSON parse failure";
            emitClaudeEvent(
              meta.events,
              createEvent(
                "runtime.warning",
                threadId,
                { message: `Ignoring malformed Claude Code event: ${message}` },
                { provider: "claude-code" },
              ),
              span,
            );
            continue;
          }

          const primary = mapClaudeEvent(threadId, raw, { turnId: meta.turnId });
          if (primary) {
            emitClaudeEvent(meta.events, primary, span);
            if (!emittedTurnStarted && primary.type === "session.started") {
              emitClaudeEvent(
                meta.events,
                createEvent(
                  "turn.started",
                  threadId,
                  { ...(model ? { model } : {}) },
                  { provider: "claude-code", turnId: meta.turnId },
                ),
                span,
              );
              emittedTurnStarted = true;
            }
          }

          const exit = mapClaudeEvent(threadId, raw, { mode: "exit", turnId: meta.turnId });
          if (exit) {
            emitClaudeEvent(meta.events, exit, span);
            meta.exitEmitted = true;
            sawSessionExit = true;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown stream failure";
        emitClaudeEvent(
          meta.events,
          createEvent(
            "runtime.error",
            threadId,
            { message: `Claude Code stream failed: ${message}`, class: "transport_error" },
            { provider: "claude-code" },
          ),
          span,
        );
      }

      const exitCode = await process.exited;
      span.addEvent("process.exited", { "orka.exit_code": exitCode });

      if (!sawSessionExit && !meta.exitEmitted) {
        emitSessionExited(
          threadId,
          meta,
          `Claude Code exited with code ${exitCode}`,
          exitCode === 0 ? "graceful" : "error",
          span,
        );
      }

      closeEvents(meta);
      return sawSessionExit;
    },
  );
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

async function waitForExit(process: ClaudeProcess, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    process.exited.finally(() => clearTimeout(timer));
  });
  const exited = process.exited.then(() => true);
  return Promise.race([exited, timeout]);
}

function emitSessionExited(
  threadId: string,
  meta: ClaudeHandleMeta,
  reason: string,
  exitKind: "graceful" | "error",
  span?: Span,
): void {
  if (meta.exitEmitted) {
    return;
  }

  meta.exitEmitted = true;
  emitClaudeEvent(
    meta.events,
    createEvent(
      "session.exited",
      threadId,
      { reason, exitKind },
      { provider: "claude-code" },
    ),
    span,
  );
}

function emitClaudeEvent(queue: AsyncEventQueue<ProviderRuntimeEvent>, event: ProviderRuntimeEvent, span?: Span): void {
  queue.push(event);
  span?.addEvent("event.emitted", { "orka.event.type": event.type });
}

function buildClaudeCommand(input: ProviderSessionStartInput): string[] {
  const command = ["claude", "-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "auto"];

  if (input.model) {
    command.push("--model", input.model);
  }

  command.push("--append-system-prompt", `[orka session: ${input.threadId}]`);

  const effort = mapClaudeReasoningEffort(input.reasoningEffort);
  if (effort) {
    command.push("--effort", effort);
  }

  return command;
}

function closeEvents(meta: ClaudeHandleMeta): void {
  if (meta.closed) {
    return;
  }

  meta.closed = true;
  meta.events.close();
}

function normalizeClaudeUsage(raw: Record<string, unknown>): ClaudeUsage | undefined {
  const modelUsage = firstModelUsage(raw.modelUsage);
  const modelUsageTokens = normalizeClaudeUsageValue(modelUsage);
  if (modelUsageTokens) {
    return modelUsageTokens;
  }

  return normalizeClaudeUsageValue(raw.usage);
}

function firstModelUsage(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  const first = Object.values(value)[0];
  return isRecord(first) ? first : undefined;
}

function normalizeClaudeUsageValue(value: unknown): ClaudeUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens =
    typeof value.inputTokens === "number"
      ? value.inputTokens
      : typeof value.input_tokens === "number"
        ? value.input_tokens
        : undefined;
  const outputTokens =
    typeof value.outputTokens === "number"
      ? value.outputTokens
      : typeof value.output_tokens === "number"
        ? value.output_tokens
        : undefined;

  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  return { inputTokens, outputTokens };
}

function extractClaudeAssistantText(content: unknown[]): string | null {
  const text = content
    .filter((item): item is Record<string, string> => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function findClaudeToolUse(content: unknown[]): { id: string; name: string; input: unknown } | null {
  for (const item of content) {
    if (!isRecord(item) || item.type !== "tool_use") {
      continue;
    }

    if (typeof item.id !== "string" || typeof item.name !== "string") {
      return null;
    }

    return {
      id: item.id,
      name: item.name,
      input: item.input,
    };
  }

  return null;
}

function mapClaudeToolItemType(name: string): "command_execution" | "file_change" | "unknown" {
  if (name === "Bash") {
    return "command_execution";
  }

  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit") {
    return "file_change";
  }

  return "unknown";
}

function formatClaudeToolTitle(name: string, input: unknown): string {
  if (name === "Bash" && isRecord(input) && typeof input.command === "string") {
    return input.command;
  }

  if (isRecord(input)) {
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.filePath === "string") return input.filePath;
  }

  return name;
}

function formatClaudeToolDetail(name: string, input: unknown): string {
  if (name === "Bash" && isRecord(input) && typeof input.command === "string") {
    return input.command;
  }

  if (typeof input === "string") {
    return input;
  }

  if (isRecord(input)) {
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.filePath === "string") return input.filePath;
  }

  if (input == null) {
    return name;
  }

  return JSON.stringify(input) ?? name;
}

function extractClaudeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value.map((entry) => extractClaudeText(entry)).filter(Boolean).join("\n");
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    return JSON.stringify(value) ?? "";
  }

  return "";
}

function getClaudeHandleMeta(handle: ProviderSessionHandle): ClaudeHandleMeta {
  const meta = handle.meta as Partial<ClaudeHandleMeta>;
  if (!meta.process || !meta.events) {
    throw new Error("Invalid Claude Code provider session handle");
  }

  return meta as ClaudeHandleMeta;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function normalizeClaudeMapOptions(
  modeOrOptions: ClaudeMapMode | ClaudeMapOptions,
): { mode: ClaudeMapMode; turnId?: string } {
  if (typeof modeOrOptions === "string") {
    return { mode: modeOrOptions, turnId: undefined };
  }

  return {
    mode: modeOrOptions.mode ?? "primary",
    turnId: modeOrOptions.turnId,
  };
}

function mapClaudeReasoningEffort(reasoningEffort?: ReasoningEffort): "low" | "medium" | "high" | "max" | undefined {
  switch (reasoningEffort) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return undefined;
  }
}
