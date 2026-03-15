import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderAdapter,
  ProviderApprovalDecision,
  RawProviderLine,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
  RuntimeItemStatus,
  RuntimeSessionState,
  RuntimeTurnState,
} from "@orka/core";
import type { Span } from "@opentelemetry/api";
import { createEvent } from "@orka/core";
import { prependSystemPrompt } from "../backends";
import { withSpan } from "../tracing";
import { buildAgentEnv } from "./env-filter";

type CodexClientRequestMethod = "initialize" | "thread/start" | "turn/start" | "turn/interrupt" | "thread/unsubscribe";
type CodexClientNotificationMethod = "initialized";
type CodexProcess = ReturnType<typeof Bun.spawn>;
type CodexSpawn = typeof Bun.spawn;
type JsonRpcId = string | number;

interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
}

interface CodexPendingRequest {
  method: CodexClientRequestMethod;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexPendingServerRequest {
  rawId: JsonRpcId;
  method: string;
  requestType: CanonicalRequestType;
  detail?: string;
  decision?: ProviderApprovalDecision;
  args?: unknown;
}

interface CodexHandleMeta {
  process: CodexProcess;
  sendRequest: <TResult>(method: CodexClientRequestMethod, params?: unknown) => Promise<TResult>;
  sendNotification: (method: CodexClientNotificationMethod, params?: unknown) => Promise<void>;
  sendResponse: (requestId: JsonRpcId, result: unknown) => Promise<void>;
  rawEvents: AsyncEventQueue<RawProviderLine>;
  pendingRequests: Map<string, CodexPendingRequest>;
  pendingServerRequests: Map<string, CodexPendingServerRequest>;
  turnUsage: Map<string, CodexUsage>;
  providerThreadId?: string;
  activeTurnId?: string;
  sawSessionExit: boolean;
}

interface JsonRpcRequest {
  id: JsonRpcId;
  method: CodexClientRequestMethod;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface MapCodexEventContext {
  meta?: Pick<CodexHandleMeta, "pendingServerRequests" | "turnUsage" | "activeTurnId" | "providerThreadId" | "sawSessionExit">;
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

export class CodexSessionProjection {
  private hasActiveTurn: boolean;
  private isSessionReady = false;
  private hasTerminalError = false;
  private hasProviderThread: boolean;
  private isUnsubscribing = false;
  private isInteractive: boolean;

  constructor(initial: { hasActiveTurn?: boolean; hasProviderThread?: boolean; interactive?: boolean } = {}) {
    this.hasActiveTurn = initial.hasActiveTurn ?? false;
    this.hasProviderThread = initial.hasProviderThread ?? false;
    this.isInteractive = initial.interactive ?? false;
  }

  apply(event: ProviderRuntimeEvent): void {
    switch (event.type) {
      case "turn.started":
        this.hasActiveTurn = true;
        return;
      case "turn.completed":
      case "turn.aborted":
        this.hasActiveTurn = false;
        return;
      case "session.state.changed":
        this.isSessionReady = event.payload.state === "ready";
        if (event.payload.state === "error") {
          this.hasTerminalError = true;
        }
        return;
      default:
        return;
    }
  }

  setProviderThread(value: boolean): void {
    this.hasProviderThread = value;
  }

  shouldUnsubscribe(): boolean {
    // Terminal errors (systemError) always trigger unsubscribe regardless of mode.
    // Normal idle completion only triggers unsubscribe for background (non-interactive) sessions.
    const shouldExit = this.hasTerminalError || (this.isSessionReady && !this.isInteractive);
    return shouldExit && !this.hasActiveTurn && this.hasProviderThread && !this.isUnsubscribing;
  }

  hasError(): boolean {
    return this.hasTerminalError;
  }

  markUnsubscribing(): void {
    this.isUnsubscribing = true;
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;

  constructor(private readonly spawnProcess: CodexSpawn = Bun.spawn.bind(Bun)) {}

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    return withSpan(
      "orka.provider.codex.start_session",
      { "orka.session.id": input.threadId, "orka.backend": this.kind },
      async (span) => {
        const command = ["codex"];
        if (input.model) {
          command.push("--model", input.model);
        }
        command.push("--dangerously-bypass-approvals-and-sandbox", "app-server");

        const process = this.spawnProcess(command, {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: buildAgentEnv(input.env),
        });
        span.addEvent("process.spawned", { "orka.command": command.join(" ") });

        const events = new AsyncEventQueue<ProviderRuntimeEvent>();
        const rawEventsQueue = new AsyncEventQueue<RawProviderLine>();

        if (!isReadableStream(process.stdout)) {
          emitCodexEvent(
            events,
            createEvent(
              "runtime.error",
              input.threadId,
              { message: "Codex app-server stdout is not available", class: "transport_error" },
              { provider: this.kind },
            ),
            span,
          );
          emitCodexEvent(
            events,
            createEvent(
              "session.exited",
              input.threadId,
              { reason: "Codex app-server failed to start stdout transport", exitKind: "error" },
              { provider: this.kind },
            ),
            span,
          );
          events.close();
          throw new Error("Codex app-server stdout is not available");
        }

        const meta = this.createHandleMeta(input.threadId, process, rawEventsQueue);
        const handle: ProviderSessionHandle = {
          threadId: input.threadId,
          provider: this.kind,
          events,
          rawEvents: rawEventsQueue,
          meta: meta as unknown as Record<string, unknown>,
        };

        if (isReadableStream(process.stderr)) {
          void drainStream(process.stderr);
        }

        void consumeCodexOutput(input.threadId, process.stdout, meta, events, process, {
          interactive: input.interactive,
        });

        try {
          await meta.sendRequest<{ userAgent: string }>("initialize", {
            clientInfo: {
              name: "orka",
              title: "Orka",
              version: "0.0.0",
            },
            capabilities: {
              experimentalApi: true,
            },
          });
          await meta.sendNotification("initialized");

          const thread = await meta.sendRequest<{ thread?: { id?: string } }>("thread/start", {
            cwd: input.cwd,
            model: input.model,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ephemeral: true,
          });

          const providerThreadId = thread.thread?.id;
          if (typeof providerThreadId !== "string" || providerThreadId.length === 0) {
            throw new Error("Codex app-server did not return a provider thread id");
          }

          meta.providerThreadId = providerThreadId;

          if (input.prompt) {
            await this.startTurn(handle, {
              input: prependSystemPrompt(input.prompt, input.systemPrompt),
              ...(input.model ? { model: input.model } : {}),
            });
          }
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
        await this.startTurn(handle, input);
      },
    );
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    await withSpan(
      "orka.provider.codex.interrupt_turn",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getCodexHandleMeta(handle);

        if (!meta.providerThreadId || !meta.activeTurnId) {
          return;
        }

        await meta.sendRequest("turn/interrupt", {
          threadId: meta.providerThreadId,
          turnId: meta.activeTurnId,
        });
      },
    );
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    await withSpan(
      "orka.provider.codex.stop_session",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind },
      async () => {
        const meta = getCodexHandleMeta(handle);

        if (meta.providerThreadId) {
          try {
            await meta.sendRequest("thread/unsubscribe", { threadId: meta.providerThreadId });
          } catch {
            // Best-effort cleanup; the subprocess may have already exited.
          }
        }

        const exited = await waitForExit(meta.process, 250);
        if (!exited) {
          meta.process.kill();
          await meta.process.exited;
        }
      },
    );
  }

  async respondToRequest(
    handle: ProviderSessionHandle,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    await withSpan(
      "orka.provider.codex.respond_to_request",
      { "orka.session.id": handle.threadId, "orka.backend": this.kind, "orka.request.id": requestId },
      async () => {
        const meta = getCodexHandleMeta(handle);
        const pending = meta.pendingServerRequests.get(requestId);
        if (!pending) {
          throw new Error(`Unknown Codex request id "${requestId}"`);
        }

        pending.decision = decision;
        await meta.sendResponse(pending.rawId, createServerRequestResponse(pending, decision));
      },
    );
  }

  private async startTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void> {
    const meta = getCodexHandleMeta(handle);
    const providerThreadId = meta.providerThreadId;
    if (!providerThreadId) {
      throw new Error("Codex provider thread has not been initialized");
    }

    const turn = await meta.sendRequest<{ turn?: { id?: string } }>("turn/start", {
      threadId: providerThreadId,
      input: [
        {
          type: "text",
          text: input.input ?? "",
          text_elements: [],
        },
      ],
      ...(input.model ? { model: input.model } : {}),
    });

    const activeTurnId = turn.turn?.id;
    if (typeof activeTurnId === "string" && activeTurnId.length > 0) {
      meta.activeTurnId = activeTurnId;
    }
  }

  private createHandleMeta(threadId: string, process: CodexProcess, rawEventsQueue: AsyncEventQueue<RawProviderLine>): CodexHandleMeta {
    let requestCount = 0;
    const pendingRequests = new Map<string, CodexPendingRequest>();
    const pendingServerRequests = new Map<string, CodexPendingServerRequest>();
    const turnUsage = new Map<string, CodexUsage>();

    const writeMessage = async (message: unknown): Promise<void> => {
      const stdin = process.stdin;
      if (!stdin || typeof stdin === "number") {
        throw new Error("Codex app-server stdin is not available");
      }

      const json = JSON.stringify(message);
      rawEventsQueue.push({ direction: "in", data: json, ts: new Date().toISOString() });
      await Promise.resolve(stdin.write(`${json}\n`));
    };

    const sendRequest = async <TResult>(method: CodexClientRequestMethod, params?: unknown): Promise<TResult> => {
      return withSpan(
        "orka.rpc.request",
        { "orka.session.id": threadId, "orka.method": method, "orka.backend": this.kind },
        async () => {
          const id = `codex-rpc-${++requestCount}`;
          const request: JsonRpcRequest = { id, method };
          if (params !== undefined) {
            request.params = params;
          }

          const result = new Promise<TResult>((resolve, reject) => {
            pendingRequests.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
          });

          try {
            await writeMessage(request);
          } catch (error) {
            pendingRequests.delete(id);
            throw error;
          }

          return result;
        },
      );
    };

    const sendNotification = async (method: CodexClientNotificationMethod, params?: unknown): Promise<void> => {
      const notification: JsonRpcNotification = { method };
      if (params !== undefined) {
        notification.params = params;
      }
      await writeMessage(notification);
    };

    const sendResponse = async (requestId: JsonRpcId, result: unknown): Promise<void> => {
      await writeMessage({ id: requestId, result });
    };

    return {
      process,
      sendRequest,
      sendNotification,
      sendResponse,
      rawEvents: rawEventsQueue,
      pendingRequests,
      pendingServerRequests,
      turnUsage,
      sawSessionExit: false,
    };
  }

  async *replayRawLog(threadId: string, lines: RawProviderLine[]): AsyncIterable<ProviderRuntimeEvent> {
    const meta: MapCodexEventContext["meta"] = {
      pendingServerRequests: new Map(),
      turnUsage: new Map(),
      sawSessionExit: false,
    };

    for (const line of lines) {
      if (line.direction !== "out") continue;

      let raw: unknown;
      try {
        raw = JSON.parse(line.data);
      } catch {
        continue;
      }

      // Skip JSON-RPC responses — they don't produce events
      if (isJsonRpcResponse(raw)) continue;

      const mapped = mapCodexEvent(threadId, raw, { meta });
      if (mapped) {
        yield mapped;
      }
    }
  }
}

export function mapCodexEvent(
  threadId: string,
  raw: unknown,
  context: MapCodexEventContext = {},
): ProviderRuntimeEvent | null {
  const meta = context.meta;

  if (isJsonRpcResponse(raw)) {
    return null;
  }

  if (isJsonRpcServerRequest(raw)) {
    const pending = mapServerRequest(raw);
    if (!pending) {
      return null;
    }

    meta?.pendingServerRequests.set(String(raw.id), pending);

    return createEvent(
      "request.opened",
      threadId,
      {
        requestType: pending.requestType,
        ...(pending.detail !== undefined ? { detail: pending.detail } : {}),
        ...(pending.args !== undefined ? { args: pending.args } : {}),
      },
      {
        provider: "codex",
        requestId: String(raw.id),
      },
    );
  }

  if (!isJsonRpcNotification(raw)) {
    return null;
  }

  if (raw.method.startsWith("codex/event/")) {
    return null;
  }

  switch (raw.method) {
    case "thread/started": {
      const providerThreadId = getString(raw.params, "thread", "id");
      if (providerThreadId) {
        meta && (meta.providerThreadId = providerThreadId);
      }
      return createEvent("session.started", threadId, {}, { provider: "codex" });
    }

    case "thread/status/changed": {
      const params = getRecord(raw.params);
      const state = mapThreadState(params?.["status"]);
      if (!state) {
        return null;
      }
      return createEvent("session.state.changed", threadId, { state }, { provider: "codex" });
    }

    case "turn/started": {
      const turnId = getString(raw.params, "turn", "id");
      if (!turnId) {
        return null;
      }

      meta && (meta.activeTurnId = turnId);
      return createEvent("turn.started", threadId, {}, { provider: "codex", turnId });
    }

    case "turn/completed": {
      const turnRecord = getRecord(getRecord(raw.params)?.["turn"]);
      if (!turnRecord || typeof turnRecord["id"] !== "string") {
        return null;
      }

      const turnId = turnRecord["id"];
      const state = mapTurnState(turnRecord["status"]);
      if (!state) {
        return null;
      }

      if (meta?.activeTurnId === turnId) {
        delete meta.activeTurnId;
      }

      const usage = meta?.turnUsage.get(turnId);
      return createEvent(
        "turn.completed",
        threadId,
        {
          state,
          ...(usage ? { usage } : {}),
        },
        { provider: "codex", turnId },
      );
    }

    case "item/started":
    case "item/completed": {
      const params = getRecord(raw.params);
      const item = getRecord(params?.["item"]);
      const turnId = typeof params?.["turnId"] === "string" ? params["turnId"] : undefined;
      if (!isRecord(item) || !turnId) {
        return null;
      }

      const itemId = typeof item["id"] === "string" ? item["id"] : undefined;
      const title = getItemTitle(item);
      const detail = getItemDetail(item);
      const payload = {
        itemType: getCanonicalItemType(item),
        status: raw.method === "item/started" ? "in_progress" : getCanonicalItemStatus(item),
        ...(title ? { title } : {}),
        ...(detail ? { detail } : {}),
      };

      return createEvent(raw.method === "item/started" ? "item.started" : "item.completed", threadId, payload, {
        provider: "codex",
        turnId,
        ...(itemId ? { itemId } : {}),
      });
    }

    case "item/agentMessage/delta":
      return createContentDeltaEvent(threadId, raw.params, "assistant_text");

    case "item/commandExecution/outputDelta":
      return createContentDeltaEvent(threadId, raw.params, "command_output");

    case "item/fileChange/outputDelta":
      return createContentDeltaEvent(threadId, raw.params, "file_change_output");

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return createContentDeltaEvent(threadId, raw.params, "reasoning_text");

    case "thread/tokenUsage/updated": {
      const params = getRecord(raw.params);
      if (!params || typeof params["turnId"] !== "string") {
        return null;
      }

      const usage = normalizeUsage(params["tokenUsage"]);
      if (usage) {
        meta?.turnUsage.set(params["turnId"], usage);
      }
      return null;
    }

    case "error": {
      const params = getRecord(raw.params);
      const error = getRecord(params?.["error"]);
      const message = typeof error?.["message"] === "string" ? error["message"] : "Codex reported an error";
      const turnId = typeof params?.["turnId"] === "string" ? params["turnId"] : undefined;
      return createEvent(
        "runtime.error",
        threadId,
        { message, class: "provider_error" },
        {
          provider: "codex",
          ...(turnId ? { turnId } : {}),
        },
      );
    }

    case "serverRequest/resolved": {
      const params = getRecord(raw.params);
      if (!params || (typeof params["requestId"] !== "string" && typeof params["requestId"] !== "number")) {
        return null;
      }

      const requestId = String(params["requestId"]);
      const pending = meta?.pendingServerRequests.get(requestId);
      meta?.pendingServerRequests.delete(requestId);
      const turnId = getString(pending?.args, "turnId");

      return createEvent(
        "request.resolved",
        threadId,
        {
          requestType: pending?.requestType ?? "unknown",
          ...(pending?.decision ? { decision: pending.decision } : {}),
        },
        {
          provider: "codex",
          requestId,
          ...(turnId ? { turnId } : {}),
        },
      );
    }

    case "thread/closed":
      meta && (meta.sawSessionExit = true);
      return createEvent(
        "session.exited",
        threadId,
        { reason: "Codex thread closed", exitKind: "graceful" },
        { provider: "codex" },
      );

    default:
      return null;
  }
}

async function consumeCodexOutput(
  threadId: string,
  stdout: ReadableStream<Uint8Array>,
  meta: CodexHandleMeta,
  events: AsyncEventQueue<ProviderRuntimeEvent>,
  process: CodexProcess,
  opts?: { interactive?: boolean },
): Promise<void> {
  await withSpan(
    "orka.provider.codex.parse_output",
    { "orka.session.id": threadId, "orka.backend": "codex" },
    async (span) => {
      const projection = new CodexSessionProjection({
        hasActiveTurn: Boolean(meta.activeTurnId),
        interactive: opts?.interactive,
        hasProviderThread: Boolean(meta.providerThreadId),
      });

      try {
        for await (const line of readLines(stdout)) {
          meta.rawEvents.push({ direction: "out", data: line, ts: new Date().toISOString() });
          let raw: unknown;

          try {
            raw = JSON.parse(line);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown JSON parse failure";
            emitCodexEvent(
              events,
              createEvent(
                "runtime.warning",
                threadId,
                { message: `Ignoring malformed Codex event: ${message}` },
                { provider: "codex" },
              ),
              span,
            );
            continue;
          }

          if (isJsonRpcResponse(raw)) {
            resolvePendingRequest(meta, raw);
            continue;
          }

          const mapped = mapCodexEvent(threadId, raw, { meta });
          if (mapped) {
            emitCodexEvent(events, mapped, span);
            projection.apply(mapped);
          }

          // In app-server mode, codex stays alive after completing work.
          // Once we see session.exited (thread/closed), break the loop and
          // proceed to process cleanup.
          if (meta.sawSessionExit) {
            span.addEvent("session_exit_detected");
            break;
          }

          projection.setProviderThread(Boolean(meta.providerThreadId));

          if (projection.shouldUnsubscribe()) {
            projection.markUnsubscribing();
            span.addEvent("idle_detected_unsubscribing");
            const providerThreadId = meta.providerThreadId;
            if (providerThreadId) {
              void meta.sendRequest("thread/unsubscribe", { threadId: providerThreadId }).catch(() => {
                // Best-effort; if it fails, stopSession will clean up.
              });
              // Safety net: if codex doesn't respond with thread/closed within 10s
              // (e.g. stuck in systemError), force-kill the process.
              if (projection.hasError()) {
                setTimeout(() => {
                  if (!meta.sawSessionExit) {
                    span.addEvent("error_unsubscribe_timeout_killing");
                    process.kill();
                  }
                }, 10_000).unref();
              }
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown stream failure";
        emitCodexEvent(
          events,
          createEvent(
            "runtime.error",
            threadId,
            { message: `Codex app-server stream failed: ${message}`, class: "transport_error" },
            { provider: "codex" },
          ),
          span,
        );
      }

      const exitCode = await process.exited;
      span.addEvent("process.exited", { "orka.exit_code": exitCode });

      for (const [requestId, pending] of meta.pendingRequests) {
        pending.reject(new Error(`Codex app-server exited before replying to ${pending.method} (${requestId})`));
      }
      meta.pendingRequests.clear();
      meta.pendingServerRequests.clear();

      if (!meta.sawSessionExit) {
        emitCodexEvent(
          events,
          createEvent(
            "session.exited",
            threadId,
            {
              reason: `Codex app-server exited with code ${exitCode}`,
              exitKind: exitCode === 0 ? "graceful" : "error",
            },
            { provider: "codex" },
          ),
          span,
        );
      }

      events.close();
      meta.rawEvents.close();
    },
  );
}

function emitCodexEvent(queue: AsyncEventQueue<ProviderRuntimeEvent>, event: ProviderRuntimeEvent, span?: Span): void {
  queue.push(event);
  span?.addEvent("event.emitted", { "orka.event.type": event.type });
}

function resolvePendingRequest(meta: CodexHandleMeta, response: JsonRpcResponse): void {
  const key = String(response.id);
  const pending = meta.pendingRequests.get(key);
  if (!pending) {
    return;
  }

  meta.pendingRequests.delete(key);

  if (response.error) {
    const message = response.error.message ?? `Codex ${pending.method} request failed`;
    pending.reject(new Error(message));
    return;
  }

  pending.resolve(response.result);
}

function createServerRequestResponse(
  pending: CodexPendingServerRequest,
  decision: ProviderApprovalDecision,
): unknown {
  switch (pending.method) {
    case "item/commandExecution/requestApproval":
      return { decision: decision === "approve" ? "accept" : "decline" };

    case "item/fileChange/requestApproval":
      return { decision: decision === "approve" ? "accept" : "decline" };

    case "item/permissions/requestApproval": {
      const permissions = getRecord(pending.args)?.["permissions"];
      return decision === "approve"
        ? { permissions: isRecord(permissions) ? permissions : {}, scope: "turn" }
        : { permissions: {}, scope: "turn" };
    }

    case "item/tool/requestUserInput":
      if (decision === "deny") {
        throw new Error("Codex tool user input requests require structured answers, not approve/deny");
      }
      return { answers: {} };

    default:
      throw new Error(`Unsupported Codex server request method "${pending.method}"`);
  }
}

function mapServerRequest(raw: JsonRpcServerRequest): CodexPendingServerRequest | null {
  const detail = getRequestDetail(raw.params, ["command", "reason"]);
  const fileChangeDetail = getRequestDetail(raw.params, ["reason", "grantRoot"]);
  const permissionDetail = getRequestDetail(raw.params, ["reason"]);
  const toolDetail = getToolRequestDetail(raw.params);

  switch (raw.method) {
    case "item/commandExecution/requestApproval":
      return {
        rawId: raw.id,
        method: raw.method,
        requestType: "command_execution_approval",
        ...(detail ? { detail } : {}),
        ...(raw.params !== undefined ? { args: raw.params } : {}),
      };

    case "item/fileChange/requestApproval":
      return {
        rawId: raw.id,
        method: raw.method,
        requestType: "file_change_approval",
        ...(fileChangeDetail ? { detail: fileChangeDetail } : {}),
        ...(raw.params !== undefined ? { args: raw.params } : {}),
      };

    case "item/permissions/requestApproval":
      return {
        rawId: raw.id,
        method: raw.method,
        requestType: "unknown",
        ...(permissionDetail ? { detail: permissionDetail } : {}),
        ...(raw.params !== undefined ? { args: raw.params } : {}),
      };

    case "item/tool/requestUserInput":
      return {
        rawId: raw.id,
        method: raw.method,
        requestType: "tool_user_input",
        ...(toolDetail ? { detail: toolDetail } : {}),
        ...(raw.params !== undefined ? { args: raw.params } : {}),
      };

    default:
      return null;
  }
}

function createContentDeltaEvent(
  threadId: string,
  rawParams: unknown,
  streamKind: "assistant_text" | "command_output" | "file_change_output" | "reasoning_text",
): ProviderRuntimeEvent | null {
  const params = getRecord(rawParams);
  if (!params || typeof params["turnId"] !== "string" || typeof params["delta"] !== "string") {
    return null;
  }

  const itemId = typeof params["itemId"] === "string" ? params["itemId"] : undefined;
  return createEvent(
    "content.delta",
    threadId,
    { streamKind, delta: params["delta"] },
    {
      provider: "codex",
      turnId: params["turnId"],
      ...(itemId ? { itemId } : {}),
    },
  );
}

function normalizeUsage(raw: unknown): CodexUsage | undefined {
  const usage = getRecord(raw);
  const total = getRecord(usage?.["total"]);
  if (!total || typeof total["inputTokens"] !== "number" || typeof total["outputTokens"] !== "number") {
    return undefined;
  }

  return {
    inputTokens: total["inputTokens"],
    outputTokens: total["outputTokens"],
  };
}

function mapThreadState(raw: unknown): RuntimeSessionState | null {
  const type = getRecord(raw)?.["type"];
  if (type === "idle") return "ready";
  if (type === "active") return "running";
  if (type === "notLoaded") return "stopped";
  if (type === "systemError") return "error";
  return null;
}

function mapTurnState(raw: unknown): RuntimeTurnState | null {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "interrupted") return "interrupted";
  return null;
}

function getCanonicalItemType(item: Record<string, unknown>): CanonicalItemType {
  switch (item["type"]) {
    case "userMessage":
      return "user_message";
    case "agentMessage":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "commandExecution":
      return "command_execution";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
      return "mcp_tool_call";
    default:
      return "unknown";
  }
}

function getCanonicalItemStatus(item: Record<string, unknown>): RuntimeItemStatus {
  if (item["type"] === "commandExecution" || item["type"] === "fileChange") {
    switch (item["status"]) {
      case "failed":
        return "failed";
      case "declined":
        return "declined";
      default:
        return "completed";
    }
  }

  return "completed";
}

function getItemTitle(item: Record<string, unknown>): string | undefined {
  switch (item["type"]) {
    case "commandExecution":
      return typeof item["command"] === "string" ? item["command"] : undefined;
    case "fileChange":
      return "File change";
    case "reasoning":
      return "Reasoning";
    case "agentMessage":
      return "Assistant message";
    case "userMessage":
      return "User message";
    case "mcpToolCall": {
      const server = typeof item["server"] === "string" ? item["server"] : undefined;
      const tool = typeof item["tool"] === "string" ? item["tool"] : undefined;
      if (server && tool) {
        return `${server}/${tool}`;
      }
      return tool ?? server;
    }
    default:
      return undefined;
  }
}

function getItemDetail(item: Record<string, unknown>): string | undefined {
  switch (item["type"]) {
    case "commandExecution":
      return typeof item["command"] === "string" ? item["command"] : undefined;
    case "agentMessage":
      return typeof item["text"] === "string" && item["text"].length > 0 ? item["text"] : undefined;
    case "userMessage":
      return getFirstUserMessageText(item["content"]);
    case "fileChange": {
      const changes = Array.isArray(item["changes"]) ? item["changes"].length : 0;
      return changes > 0 ? `${changes} file change${changes === 1 ? "" : "s"}` : undefined;
    }
    default:
      return undefined;
  }
}

function getFirstUserMessageText(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  for (const entry of raw) {
    if (!isRecord(entry) || entry["type"] !== "text" || typeof entry["text"] !== "string") {
      continue;
    }
    return entry["text"];
  }

  return undefined;
}

function getRequestDetail(raw: unknown, keys: string[]): string | undefined {
  const record = getRecord(raw);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function getToolRequestDetail(raw: unknown): string | undefined {
  const questions = getRecord(raw)?.["questions"];
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }

  const first = questions.find((entry) => isRecord(entry) && typeof entry["question"] === "string");
  return isRecord(first) && typeof first["question"] === "string" ? first["question"] : undefined;
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

async function waitForExit(process: CodexProcess, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    process.exited.finally(() => clearTimeout(timer));
  });
  const exited = process.exited.then(() => true);
  return Promise.race([exited, timeout]);
}

function getCodexHandleMeta(handle: ProviderSessionHandle): CodexHandleMeta {
  const meta = handle.meta as Partial<CodexHandleMeta>;
  if (!meta.process || typeof meta.sendRequest !== "function" || typeof meta.sendResponse !== "function") {
    throw new Error("Invalid Codex provider session handle");
  }

  return meta as CodexHandleMeta;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && "id" in value && !("method" in value) && ("result" in value || "error" in value);
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value) && typeof value["method"] === "string" && !("id" in value);
}

function isJsonRpcServerRequest(value: unknown): value is JsonRpcServerRequest {
  return isRecord(value) && typeof value["method"] === "string" && "id" in value;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getString(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return typeof current === "string" ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
