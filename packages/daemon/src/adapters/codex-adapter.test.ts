import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, mapCodexEvent } from "./codex-adapter";
import { initTracing } from "../tracing";

const originalOrkaHome = process.env.ORKA_HOME;

let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "orka-codex-adapter-"));
  process.env.ORKA_HOME = testHome;
  initTracing();
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  if (originalOrkaHome === undefined) {
    delete process.env.ORKA_HOME;
  } else {
    process.env.ORKA_HOME = originalOrkaHome;
  }
});

function createMeta() {
  return {
    pendingServerRequests: new Map<
      string,
      { requestType: "command_execution_approval" | "tool_user_input" | "unknown"; decision?: "approve" | "deny" }
    >(),
    turnUsage: new Map<string, { inputTokens: number; outputTokens: number }>(),
    sawSessionExit: false,
  };
}

describe("mapCodexEvent", () => {
  test("maps thread/started to session.started", () => {
    const event = mapCodexEvent("thread-1", {
      method: "thread/started",
      params: {
        thread: { id: "provider-thread-1" },
      },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.started");
    expect(event?.provider).toBe("codex");
    expect(event?.threadId).toBe("thread-1");
  });

  test("maps thread/status/changed to canonical session state", () => {
    const event = mapCodexEvent("thread-1", {
      method: "thread/status/changed",
      params: {
        threadId: "provider-thread-1",
        status: { type: "active", activeFlags: [] },
      },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.state.changed");
    expect(event?.payload).toEqual({ state: "running" });
  });

  test("ignores duplicate codex/event legacy notifications", () => {
    const event = mapCodexEvent("thread-1", {
      method: "codex/event/agent_message_delta",
      params: {
        id: "turn-1",
        msg: { type: "agent_message_delta", delta: "OK" },
      },
    });

    expect(event).toBeNull();
  });

  test("maps item/agentMessage/delta to assistant content delta", () => {
    const event = mapCodexEvent("thread-1", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "OK",
      },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("content.delta");
    expect(event?.turnId).toBe("turn-1");
    expect(event?.itemId).toBe("msg-1");
    expect(event?.payload).toEqual({
      streamKind: "assistant_text",
      delta: "OK",
    });
  });

  test("folds thread/tokenUsage/updated into turn/completed usage", () => {
    const meta = createMeta();

    expect(
      mapCodexEvent(
        "thread-1",
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                inputTokens: 12,
                outputTokens: 34,
              },
            },
          },
        },
        { meta },
      ),
    ).toBeNull();

    const event = mapCodexEvent(
      "thread-1",
      {
        method: "turn/completed",
        params: {
          threadId: "provider-thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [],
          },
        },
      },
      { meta },
    );

    expect(event).not.toBeNull();
    expect(event?.type).toBe("turn.completed");
    expect(event?.payload).toEqual({
      state: "completed",
      usage: {
        inputTokens: 12,
        outputTokens: 34,
      },
    });
  });

  test("maps approval server requests to request.opened and resolved", () => {
    const meta = createMeta();

    const opened = mapCodexEvent(
      "thread-1",
      {
        id: "req-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "rm -rf .",
          reason: "Needs full access",
        },
      },
      { meta },
    );

    expect(opened).not.toBeNull();
    expect(opened?.type).toBe("request.opened");
    expect(opened?.requestId).toBe("req-1");
    expect(opened?.payload).toEqual({
      requestType: "command_execution_approval",
      detail: "rm -rf .",
      args: {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "rm -rf .",
        reason: "Needs full access",
      },
    });

    const pending = meta.pendingServerRequests.get("req-1");
    expect(pending).toBeDefined();
    pending!.decision = "approve";

    const resolved = mapCodexEvent(
      "thread-1",
      {
        method: "serverRequest/resolved",
        params: {
          threadId: "provider-thread-1",
          requestId: "req-1",
        },
      },
      { meta },
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.type).toBe("request.resolved");
    expect(resolved?.requestId).toBe("req-1");
    expect(resolved?.payload).toEqual({
      requestType: "command_execution_approval",
      decision: "approve",
    });
  });

  test("maps error notifications to runtime.error", () => {
    const event = mapCodexEvent("thread-1", {
      method: "error",
      params: {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "Model failed",
        },
      },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("runtime.error");
    expect(event?.turnId).toBe("turn-1");
    expect(event?.payload).toEqual({
      message: "Model failed",
      class: "provider_error",
    });
  });
});

describe("CodexAdapter", () => {
  test("startSession records the codex start_session span", async () => {
    const spawnCalls: Array<{ command: string[]; options: Record<string, unknown> }> = [];
    const stdout = createControlledTextStream();
    const writes: Array<{ id?: string | number; method?: string; params?: any }> = [];
    const stdin = new MockWritableSink((value) => {
      const message = JSON.parse(value) as { id?: string; method?: string };
      writes.push(message);

      if (message.method === "initialize") {
        stdout.pushJson({ id: message.id, result: { userAgent: "orka-test" } });
        return;
      }

      if (message.method === "thread/start") {
        stdout.pushJson({ id: message.id, result: { thread: { id: "provider-thread-1" } } });
        return;
      }

      if (message.method === "turn/start") {
        stdout.pushJson({ id: message.id, result: { turn: { id: "turn-1" } } });
        stdout.close();
      }
    });

    const adapter = new CodexAdapter(((command, options) => {
      spawnCalls.push({ command: [...command], options: options as Record<string, unknown> });
      return {
        stdout: stdout.stream,
        stderr: createTextStream([]),
        stdin,
        exited: Promise.resolve(0),
        kill() {},
      } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);

    const handle = await adapter.startSession({
      threadId: "thread-1",
      cwd: "/tmp/project",
      model: "gpt-5",
      prompt: "Fix the tests",
      systemPrompt: "Focus on correctness.",
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(handle.provider).toBe("codex");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toEqual([
      "codex",
      "--model",
      "gpt-5",
      "--dangerously-bypass-approvals-and-sandbox",
      "app-server",
    ]);
    expect(spawnCalls[0]?.options.cwd).toBe("/tmp/project");
    expect(spawnCalls[0]?.options.env).toMatchObject({ OPENAI_API_KEY: "test-key" });

    const turnStart = writes.find((message) => message.method === "turn/start");
    expect(turnStart?.params?.input).toEqual([
      {
        type: "text",
        text: "Focus on correctness.\n\nFix the tests",
        text_elements: [],
      },
    ]);

    const startSpan = readTraceEntries().find((entry) => entry.name === "orka.provider.codex.start_session");

    expect(startSpan).toBeDefined();
    expect(startSpan?.attributes).toMatchObject({
      "orka.session.id": "thread-1",
      "orka.backend": "codex",
    });
    expect(startSpan?.events.some((event) => {
      return (
        event.name === "process.spawned" &&
        event.attributes?.["orka.command"] ===
          "codex --model gpt-5 --dangerously-bypass-approvals-and-sandbox app-server"
      );
    })).toBe(true);
  });
});

function createControlledTextStream(): {
  stream: ReadableStream<Uint8Array>;
  pushJson(value: unknown): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  return {
    stream: new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
    pushJson(value: unknown) {
      controller?.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    },
    close() {
      controller?.close();
    },
  };
}

function createTextStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

class MockWritableSink {
  constructor(private readonly onWrite: (value: string) => void) {}

  write(value: string): void {
    this.onWrite(value);
  }

  end(): void {}
}

function readTraceEntries(): Array<{
  name: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
}> {
  const traceFile = join(testHome, "traces.jsonl");
  if (!existsSync(traceFile)) {
    return [];
  }

  return readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      JSON.parse(line) as {
        name: string;
        attributes: Record<string, unknown>;
        events: Array<{ name: string; attributes?: Record<string, unknown> }>;
      },
    );
}
