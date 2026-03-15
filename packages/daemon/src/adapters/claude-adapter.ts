import type {
  CanonicalItemType,
  ProviderAdapter,
  ProviderApprovalDecision,
  RawProviderLine,
  ReasoningEffort,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import type { Span } from "@opentelemetry/api";
import { createEvent, generateId } from "@orka/core";
import { withSpan } from "../tracing";
import { buildAgentEnv } from "./env-filter";

type ClaudeProcess = ReturnType<typeof Bun.spawn>;
type ClaudeSpawn = typeof Bun.spawn;
type ClaudeMapMode = "primary" | "exit";

interface ClaudeMapOptions {
  mode?: ClaudeMapMode;
  turnId?: string;
}

interface ClaudeStdinWriter {
  write(value: string): unknown;
  end(): void;
}

interface ClaudeHandleMeta {
  process: ClaudeProcess;
  events: AsyncEventQueue<ProviderRuntimeEvent>;
  rawEvents: AsyncEventQueue<RawProviderLine>;
  exitEmitted: boolean;
  closed: boolean;
  turnId: string;
  stdinWriter: ClaudeStdinWriter;
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
        const rawEvents = new AsyncEventQueue<RawProviderLine>();
        const turnId = generateId("turn");
        const command = buildClaudeCommand(input);
        // Filter env to safe vars only, then remove CLAUDECODE to prevent nested session detection
        const spawnEnv = buildAgentEnv(input.env);
        delete spawnEnv["CLAUDECODE"];

        const process = this.spawnProcess(command, {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: spawnEnv,
        });
        span.addEvent("process.spawned", { "orka.command": command.join(" ") });
        const stdout = process.stdout;
        const stdin = process.stdin;

        const meta: ClaudeHandleMeta = {
          process,
          events,
          rawEvents,
          exitEmitted: false,
          closed: false,
          turnId,
          stdinWriter: stdin as unknown as ClaudeStdinWriter,
        };

        const handle: ProviderSessionHandle = {
          threadId: input.threadId,
          provider: this.kind,
          events,
          rawEvents,
          meta: meta as unknown as Record<string, unknown>,
        };

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
            const msg = JSON.stringify({
              type: "user",
              message: { role: "user", content: input.prompt },
              parent_tool_use_id: null,
            }) + "\n";
            rawEvents.push({ direction: "in", data: msg.trimEnd(), ts: new Date().toISOString() });
            await Promise.resolve(stdin.write(msg));
          }
          // Close stdin for non-interactive (background) sessions so Claude Code exits after one turn.
          // Keep open for interactive sessions to allow multi-turn via sendTurn().
          if (!input.interactive) {
            await Promise.resolve(stdin.end());
          }
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

  async sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void> {
    const meta = getClaudeHandleMeta(handle);
    const newTurnId = generateId("turn");
    meta.turnId = newTurnId;

    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: input.input ?? "" },
      parent_tool_use_id: null,
    }) + "\n";

    meta.rawEvents.push({ direction: "in", data: msg.trimEnd(), ts: new Date().toISOString() });
    await Promise.resolve(meta.stdinWriter.write(msg));
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

        // Close stdin to signal Claude Code to finish and exit
        try { meta.stdinWriter.end(); } catch { /* already closed */ }

        // Wait for graceful exit, then escalate
        const exitedGracefully = await waitForExit(meta.process, 10_000);
        if (!exitedGracefully) {
          meta.process.kill("SIGINT");
          const exitedAfterInt = await waitForExit(meta.process, 5_000);
          if (!exitedAfterInt) {
            meta.process.kill();
            await meta.process.exited;
          }
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

  async *replayRawLog(threadId: string, lines: RawProviderLine[]): AsyncIterable<ProviderRuntimeEvent> {
    let turnId = generateId("turn");
    let openItemId: string | null = null;
    let openItemType: CanonicalItemType = "unknown";

    for (const line of lines) {
      if (line.direction !== "out") continue;

      let raw: unknown;
      try {
        raw = JSON.parse(line.data);
      } catch {
        continue;
      }

      const primary = mapClaudeEvent(threadId, raw, { turnId });
      if (!primary) continue;

      // Close previous open item when a new item starts
      if (openItemId) {
        const isCompletionForSameItem = primary.type === "item.completed" && primary.itemId === openItemId;
        if (isCompletionForSameItem) {
          openItemId = null;
          openItemType = "unknown";
        } else if (primary.type !== "item.started" || primary.itemId !== openItemId) {
          yield createEvent(
            "item.completed",
            threadId,
            { itemType: openItemType, status: "completed" },
            { provider: "claude-code", turnId, itemId: openItemId, createdAt: line.ts },
          );
          openItemId = null;
          openItemType = "unknown";
        }
      }

      yield primary;

      if (primary.type === "item.started") {
        openItemId = primary.itemId ?? null;
        openItemType = primary.payload.itemType ?? "unknown";
      }

      if (primary.type === "session.started") {
        yield createEvent(
          "turn.started",
          threadId,
          {},
          { provider: "claude-code", turnId, createdAt: line.ts },
        );
      }

      if (primary.type === "turn.completed") {
        if (openItemId) {
          yield createEvent(
            "item.completed",
            threadId,
            { itemType: openItemType, status: "completed" },
            { provider: "claude-code", turnId, itemId: openItemId, createdAt: line.ts },
          );
          openItemId = null;
          openItemType = "unknown";
        }
        turnId = generateId("turn");
      }
    }

    // Close any remaining open item
    if (openItemId) {
      yield createEvent(
        "item.completed",
        threadId,
        { itemType: openItemType, status: "completed" },
        { provider: "claude-code", turnId, itemId: openItemId },
      );
    }

    // Emit session.exited from the last "result" line (exit mode)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.direction !== "out") continue;
      try {
        const raw = JSON.parse(line.data);
        const exitEvent = mapClaudeEvent(threadId, raw, "exit");
        if (exitEvent) {
          yield exitEvent;
          break;
        }
      } catch {
        continue;
      }
    }
  }
}

export function mapClaudeEvent(
  threadId: string,
  raw: unknown,
  modeOrOptions: ClaudeMapMode | ClaudeMapOptions = "primary",
): ProviderRuntimeEvent | null {
  const { mode, turnId } = normalizeClaudeMapOptions(modeOrOptions);

  if (!isRecord(raw) || typeof raw["type"] !== "string") {
    return null;
  }

  if (mode === "exit" && raw["type"] !== "result") {
    return null;
  }

  if (raw["type"] === "result") {
    if (mode === "exit") {
      return createEvent(
        "session.exited",
        threadId,
        {
          reason: typeof raw["subtype"] === "string" ? `Claude Code result: ${raw["subtype"]}` : "Claude Code completed",
          exitKind: raw["is_error"] === true ? "error" : "graceful",
        },
        { provider: "claude-code" },
      );
    }

    const usage = normalizeClaudeUsage(raw);
    return createEvent(
      "turn.completed",
      threadId,
      {
        state: raw["is_error"] === true ? "failed" : "completed",
        ...(typeof raw["subtype"] === "string" ? { stopReason: raw["subtype"] } : {}),
        ...(typeof raw["total_cost_usd"] === "number" ? { totalCostUsd: raw["total_cost_usd"] } : {}),
        ...(usage ? { usage } : {}),
      },
      { provider: "claude-code", ...(turnId ? { turnId } : {}) },
    );
  }

  switch (raw["type"]) {
    case "system":
      if (raw["subtype"] !== "init") {
        return null;
      }

      return createEvent(
        "session.started",
        threadId,
        { ...(typeof raw["message"] === "string" ? { message: raw["message"] } : {}) },
        { provider: "claude-code" },
      );

    case "assistant": {
      const message = isRecord(raw["message"]) ? raw["message"] : undefined;
      const content = Array.isArray(message?.["content"]) ? message["content"] : [];
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
            args: toolUse.input,
          },
          { provider: "claude-code", ...(turnId ? { turnId } : {}), itemId: toolUse.id },
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
        { provider: "claude-code", ...(turnId ? { turnId } : {}) },
      );
    }

    case "tool": {
      const detail = extractClaudeText(raw["content"]);
      const itemId = typeof raw["tool_use_id"] === "string" ? raw["tool_use_id"] : undefined;
      return createEvent(
        "item.completed",
        threadId,
        {
          itemType: "unknown",
          status: "completed",
          ...(detail ? { detail } : {}),
        },
        { provider: "claude-code", ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) },
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
      let emittedTurnStarted = false;
      // Track open item so we can emit item.completed when the next event implies it's done.
      // Claude Code stream-json never emits "tool" type events, so item.completed must be inferred.
      let openItemId: string | null = null;
      let openItemType: CanonicalItemType = "unknown";

      function closeOpenItem() {
        if (!openItemId) return;
        emitClaudeEvent(
          meta.events,
          createEvent(
            "item.completed",
            threadId,
            { itemType: openItemType, status: "completed" },
            { provider: "claude-code", ...(meta.turnId ? { turnId: meta.turnId } : {}), itemId: openItemId },
          ),
          span,
        );
        openItemId = null;
        openItemType = "unknown";
      }

      try {
        for await (const line of readLines(stdout)) {
          meta.rawEvents.push({ direction: "out", data: line, ts: new Date().toISOString() });
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
            // Close the previous open item when we see a different event.
            // Skip if the incoming event is already item.completed for the same item (from "tool" events).
            if (openItemId) {
              const isCompletionForSameItem = primary.type === "item.completed" && primary.itemId === openItemId;
              if (isCompletionForSameItem) {
                openItemId = null;
                openItemType = "unknown"; // Already completed by the mapped event
              } else if (primary.type !== "item.started" || primary.itemId !== openItemId) {
                closeOpenItem();
              }
            }

            emitClaudeEvent(meta.events, primary, span);

            // Track new open item
            if (primary.type === "item.started") {
              openItemId = primary.itemId;
              openItemType = primary.payload.itemType ?? "unknown";
            }

            if (primary.type === "session.started") {
              if (emittedTurnStarted) {
                // New turn: system:init re-emitted after a previous turn completed
                const newTurnId = generateId("turn");
                meta.turnId = newTurnId;
                emitClaudeEvent(
                  meta.events,
                  createEvent(
                    "turn.started",
                    threadId,
                    { ...(model ? { model } : {}) },
                    { provider: "claude-code", turnId: newTurnId },
                  ),
                  span,
                );
              } else {
                // First turn
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

            // On result (turn.completed), close any open item but do NOT emit session.exited.
            // session.exited is emitted only when the process actually exits.
            if (primary.type === "turn.completed") {
              closeOpenItem();
            }
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

      // Close any remaining open item on stream end
      closeOpenItem();

      const exitCode = await process.exited;
      span.addEvent("process.exited", { "orka.exit_code": exitCode });

      if (!meta.exitEmitted) {
        emitSessionExited(
          threadId,
          meta,
          `Claude Code exited with code ${exitCode}`,
          exitCode === 0 ? "graceful" : "error",
          span,
        );
      }

      closeEvents(meta);
      return meta.exitEmitted;
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
  // Background sessions run in isolated worktrees — bypass all permission checks.
  // Interactive sessions use "auto" which still prompts for some operations.
  const permissionMode = input.interactive ? "auto" : "bypassPermissions";
  const command = ["claude", "-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--permission-mode", permissionMode];

  if (input.model) {
    command.push("--model", input.model);
  }

  if (input.systemPrompt) {
    command.push("--append-system-prompt", input.systemPrompt);
  }
  command.push("--append-system-prompt", `[orka session: ${input.threadId}]`);
  if (input.allowedTools && input.allowedTools.length > 0) {
    command.push("--allowedTools", input.allowedTools.join(","));
  }

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
  meta.rawEvents.close();
}

function normalizeClaudeUsage(raw: Record<string, unknown>): ClaudeUsage | undefined {
  const modelUsage = firstModelUsage(raw["modelUsage"]);
  const modelUsageTokens = normalizeClaudeUsageValue(modelUsage);
  if (modelUsageTokens) {
    return modelUsageTokens;
  }

  return normalizeClaudeUsageValue(raw["usage"]);
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
    typeof value["inputTokens"] === "number"
      ? value["inputTokens"]
      : typeof value["input_tokens"] === "number"
        ? value["input_tokens"]
        : undefined;
  const outputTokens =
    typeof value["outputTokens"] === "number"
      ? value["outputTokens"]
      : typeof value["output_tokens"] === "number"
        ? value["output_tokens"]
        : undefined;

  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  return { inputTokens, outputTokens };
}

function extractClaudeAssistantText(content: unknown[]): string | null {
  const text = content
    .filter((item): item is Record<string, string> => isRecord(item) && item["type"] === "text" && typeof item["text"] === "string")
    .map((item) => item["text"])
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function findClaudeToolUse(content: unknown[]): { id: string; name: string; input: unknown } | null {
  for (const item of content) {
    if (!isRecord(item) || item["type"] !== "tool_use") {
      continue;
    }

    if (typeof item["id"] !== "string" || typeof item["name"] !== "string") {
      return null;
    }

    return {
      id: item["id"],
      name: item["name"],
      input: item["input"],
    };
  }

  return null;
}

function mapClaudeToolItemType(name: string): CanonicalItemType {
  switch (name) {
    case "Bash":
      return "command_execution";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "file_change";
    case "Read":
      return "file_read";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Agent":
      return "agent";
    default:
      return "unknown";
  }
}

function getInputString(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

function formatClaudeToolTitle(name: string, input: unknown): string {
  const path = getInputString(input, "file_path", "filePath");

  switch (name) {
    case "Bash":
      return getInputString(input, "command") ?? name;
    case "Read":
      return path ? `Read ${path}` : name;
    case "Edit":
    case "MultiEdit":
      return path ? `Edit ${path}` : name;
    case "Write":
      return path ? `Write ${path}` : name;
    case "Grep":
      return `Grep ${getInputString(input, "pattern") ?? ""}`;
    case "Glob":
      return `Glob ${getInputString(input, "pattern") ?? ""}`;
    case "WebFetch":
      return `Fetch ${getInputString(input, "url") ?? ""}`;
    case "WebSearch":
      return `Search ${getInputString(input, "query") ?? ""}`;
    case "Agent": {
      const desc = getInputString(input, "description");
      return desc ? `Agent: ${desc}` : name;
    }
    case "NotebookEdit":
      return path ? `NotebookEdit ${path}` : name;
    default:
      return path ? `${name} ${path}` : name;
  }
}

function formatClaudeToolDetail(name: string, input: unknown): string {
  const path = getInputString(input, "file_path", "filePath");

  switch (name) {
    case "Bash":
      return getInputString(input, "command") ?? name;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return path ?? name;
    case "Grep": {
      const pattern = getInputString(input, "pattern") ?? "";
      const searchPath = getInputString(input, "path");
      return searchPath ? `${pattern} in ${searchPath}` : pattern;
    }
    case "Glob": {
      const pattern = getInputString(input, "pattern") ?? "";
      const searchPath = getInputString(input, "path");
      return searchPath ? `${pattern} in ${searchPath}` : pattern;
    }
    case "WebFetch":
      return getInputString(input, "url") ?? name;
    case "WebSearch":
      return getInputString(input, "query") ?? name;
    case "Agent":
      return getInputString(input, "description", "prompt") ?? name;
    default:
      return path ?? (input == null ? name : (typeof input === "string" ? input : (JSON.stringify(input) ?? name)));
  }
}

function extractClaudeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value.map((entry) => extractClaudeText(entry)).filter(Boolean).join("\n");
  }

  if (isRecord(value)) {
    if (typeof value["text"] === "string") return value["text"];
    if (typeof value["content"] === "string") return value["content"];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeClaudeMapOptions(
  modeOrOptions: ClaudeMapMode | ClaudeMapOptions,
): { mode: ClaudeMapMode; turnId?: string } {
  if (typeof modeOrOptions === "string") {
    return { mode: modeOrOptions };
  }

  return {
    mode: modeOrOptions.mode ?? "primary",
    ...(modeOrOptions.turnId ? { turnId: modeOrOptions.turnId } : {}),
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
