import { ApprovalManager } from "./approval-manager";
import { ClaudeCodeAdapter, CodexAdapter, ShellAdapter } from "./adapters";
import { getConfig } from "./config";
import { getOrchestrationEvents, insertOrchestrationEvent } from "./db";
import { OrchestrationEngine } from "./orchestration/engine";
import { ProviderAdapterRegistry } from "./provider-registry";
import { ProviderService } from "./provider-service";
import { pushHub } from "./push";

export const providerAdapterRegistry = new ProviderAdapterRegistry();
providerAdapterRegistry.register("claude-code", new ClaudeCodeAdapter());
providerAdapterRegistry.register("codex", new CodexAdapter());
providerAdapterRegistry.register("shell", new ShellAdapter());

export const approvalManager = new ApprovalManager();

export const providerService = new ProviderService(providerAdapterRegistry);

export const orchestrationEngine = new OrchestrationEngine({
  pushHub,
  persistEvent: insertOrchestrationEvent,
  getSessionTimeline: getOrchestrationEvents,
});

export function isProviderRuntimeEnabled(): boolean {
  return getConfig().providers.useRuntime;
}
