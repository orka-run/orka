import { describe, expect, test } from "bun:test";
import { mapCodexEvent } from "./codex-adapter";

function createMeta() {
  return {
    pendingServerRequests: new Map<string, { requestType: "command_execution_approval" | "tool_user_input" | "unknown"; decision?: "approve" | "deny" }>(),
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
