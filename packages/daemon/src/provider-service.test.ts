import { describe, expect, test } from "bun:test";
import type {
  ProviderAdapter,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import { ProviderAdapterRegistry } from "./provider-registry";
import { ProviderService } from "./provider-service";

function createEvents(): AsyncIterable<ProviderRuntimeEvent> {
  return (async function* () {})();
}

class MockAdapter implements ProviderAdapter {
  readonly startCalls: ProviderSessionStartInput[] = [];
  readonly sendTurnCalls: Array<{ handle: ProviderSessionHandle; input: ProviderSendTurnInput }> = [];
  readonly interruptCalls: ProviderSessionHandle[] = [];
  readonly stopCalls: ProviderSessionHandle[] = [];
  readonly approvalCalls: Array<{
    handle: ProviderSessionHandle;
    requestId: string;
    decision: ProviderApprovalDecision;
  }> = [];

  constructor(readonly kind: ProviderAdapter["kind"]) {}

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    this.startCalls.push(input);
    return {
      threadId: input.threadId,
      provider: this.kind,
      events: createEvents(),
      meta: { adapterKind: this.kind },
    };
  }

  async sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void> {
    this.sendTurnCalls.push({ handle, input });
  }

  async interruptTurn(handle: ProviderSessionHandle): Promise<void> {
    this.interruptCalls.push(handle);
  }

  async stopSession(handle: ProviderSessionHandle): Promise<void> {
    this.stopCalls.push(handle);
  }

  async respondToRequest(
    handle: ProviderSessionHandle,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    this.approvalCalls.push({ handle, requestId, decision });
  }
}

describe("ProviderService", () => {
  test("starts sessions with the correct adapter and tracks the handle", async () => {
    const registry = new ProviderAdapterRegistry();
    const codex = new MockAdapter("codex");
    const shell = new MockAdapter("shell");
    registry.register("codex", codex);
    registry.register("shell", shell);
    const service = new ProviderService(registry);

    const handle = await service.startSession("codex", {
      threadId: "thread-1",
      cwd: "/tmp/project",
      prompt: "hello",
    });

    expect(codex.startCalls).toEqual([{ threadId: "thread-1", cwd: "/tmp/project", prompt: "hello" }]);
    expect(shell.startCalls).toEqual([]);
    expect(handle.provider).toBe("codex");
    expect(service.getHandle("thread-1")).toBe(handle);
    expect(service.listActiveSessions()).toEqual([handle]);
  });

  test("routes turn, interrupt, approval, and stop operations by thread id", async () => {
    const registry = new ProviderAdapterRegistry();
    const codex = new MockAdapter("codex");
    registry.register("codex", codex);
    const service = new ProviderService(registry);

    const handle = await service.startSession("codex", { threadId: "thread-2" });

    await service.sendTurn("thread-2", { input: "next step", model: "gpt-5" });
    await service.interruptTurn("thread-2");
    await service.respondToRequest("thread-2", "req-1", "approve");
    await service.stopSession("thread-2");

    expect(codex.sendTurnCalls).toEqual([{ handle, input: { input: "next step", model: "gpt-5" } }]);
    expect(codex.interruptCalls).toEqual([handle]);
    expect(codex.approvalCalls).toEqual([{ handle, requestId: "req-1", decision: "approve" }]);
    expect(codex.stopCalls).toEqual([handle]);
    expect(service.getHandle("thread-2")).toBeUndefined();
    expect(service.listActiveSessions()).toEqual([]);
  });

  test("throws for unknown thread ids", async () => {
    const registry = new ProviderAdapterRegistry();
    const service = new ProviderService(registry);

    await expect(service.sendTurn("missing-thread", { input: "test" })).rejects.toThrow(
      'No active provider session for thread "missing-thread"',
    );
    await expect(service.interruptTurn("missing-thread")).rejects.toThrow(
      'No active provider session for thread "missing-thread"',
    );
    await expect(service.stopSession("missing-thread")).rejects.toThrow(
      'No active provider session for thread "missing-thread"',
    );
    await expect(service.respondToRequest("missing-thread", "req-1", "deny")).rejects.toThrow(
      'No active provider session for thread "missing-thread"',
    );
  });
});
