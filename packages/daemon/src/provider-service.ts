import type {
  BackendKind,
  ProviderApprovalDecision,
  ProviderSendTurnInput,
  ProviderSessionHandle,
  ProviderSessionStartInput,
} from "@orka/core";
import type { ProviderAdapterRegistry } from "./provider-registry";
import { withSpan, withSpanSync } from "./tracing";

export class ProviderService {
  private sessions = new Map<string, ProviderSessionHandle>();

  constructor(private registry: ProviderAdapterRegistry) {}

  async startSession(kind: BackendKind, input: ProviderSessionStartInput): Promise<ProviderSessionHandle> {
    return withSpan(
      "orka.provider.start_session",
      { "orka.backend": kind, "orka.session.id": input.threadId },
      async () => {
        const adapter = this.registry.get(kind);
        const handle = await adapter.startSession(input);

        if (handle.provider !== kind) {
          throw new Error(
            `Provider session handle kind mismatch: expected "${kind}", received "${handle.provider}"`,
          );
        }

        const existing = this.sessions.get(handle.threadId);
        if (existing) {
          throw new Error(`Provider session already exists for thread "${handle.threadId}"`);
        }

        this.sessions.set(handle.threadId, handle);
        return handle;
      },
    );
  }

  async sendTurn(threadId: string, input: ProviderSendTurnInput): Promise<void> {
    await withSpan("orka.provider.send_turn", { "orka.session.id": threadId }, async () => {
      const handle = this.requireHandle(threadId);
      const adapter = this.registry.get(handle.provider);
      await adapter.sendTurn(handle, input);
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    await withSpan("orka.provider.interrupt_turn", { "orka.session.id": threadId }, async () => {
      const handle = this.requireHandle(threadId);
      const adapter = this.registry.get(handle.provider);
      await adapter.interruptTurn(handle);
    });
  }

  async steerTurn(threadId: string, input: ProviderSendTurnInput): Promise<void> {
    await withSpan("orka.provider.steer_turn", { "orka.session.id": threadId }, async () => {
      const handle = this.requireHandle(threadId);
      const adapter = this.registry.get(handle.provider);
      if (!adapter.steerTurn) {
        throw new Error(`Backend "${handle.provider}" does not support mid-turn steering`);
      }
      await adapter.steerTurn(handle, input);
    });
  }

  async cancelTurn(threadId: string): Promise<void> {
    await withSpan("orka.provider.cancel_turn", { "orka.session.id": threadId }, async () => {
      const handle = this.requireHandle(threadId);
      const adapter = this.registry.get(handle.provider);
      if (adapter.cancelTurn) {
        await adapter.cancelTurn(handle);
      } else {
        // Fall back to interruptTurn for adapters that don't implement cancelTurn
        await adapter.interruptTurn(handle);
      }
    });
  }

  supportsSteer(threadId: string): boolean {
    const handle = this.sessions.get(threadId);
    if (!handle) return false;
    const adapter = this.registry.get(handle.provider);
    return typeof adapter.steerTurn === "function";
  }

  async stopSession(threadId: string): Promise<void> {
    await withSpan("orka.provider.stop_session", { "orka.session.id": threadId }, async () => {
      const handle = this.requireHandle(threadId);
      const adapter = this.registry.get(handle.provider);
      await adapter.stopSession(handle);
      this.sessions.delete(threadId);
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    await withSpan(
      "orka.provider.respond_to_request",
      { "orka.session.id": threadId, "orka.request.id": requestId },
      async () => {
        const handle = this.requireHandle(threadId);
        const adapter = this.registry.get(handle.provider);
        await adapter.respondToRequest(handle, requestId, decision);
      },
    );
  }

  getHandle(threadId: string): ProviderSessionHandle | undefined {
    return withSpanSync("orka.provider.get_handle", { "orka.session.id": threadId }, () => this.sessions.get(threadId));
  }

  clearHandle(threadId: string): void {
    withSpanSync("orka.provider.clear_handle", { "orka.session.id": threadId }, () => {
      this.sessions.delete(threadId);
    });
  }

  listActiveSessions(): ProviderSessionHandle[] {
    return withSpanSync("orka.provider.list_active_sessions", {}, () => Array.from(this.sessions.values()));
  }

  private requireHandle(threadId: string): ProviderSessionHandle {
    const handle = this.sessions.get(threadId);
    if (!handle) {
      throw new Error(`No active provider session for thread "${threadId}"`);
    }

    return handle;
  }
}
