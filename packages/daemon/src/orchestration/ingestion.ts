import type { ProviderRuntimeEvent } from "@orka/core";
import type { OrchestrationEvent } from "./events";

export function mapProviderEvent(sessionId: string, event: ProviderRuntimeEvent): OrchestrationEvent | null {
  switch (event.type) {
    case "session.started":
      return { type: "session.started", sessionId, timestamp: event.createdAt };
    case "turn.started":
      return { type: "turn.started", sessionId, turnId: event.turnId!, timestamp: event.createdAt };
    case "content.delta":
      return {
        type: "content.delta",
        sessionId,
        turnId: event.turnId!,
        delta: event.payload.delta,
        timestamp: event.createdAt,
      };
    case "turn.completed":
      return {
        type: "turn.completed",
        sessionId,
        turnId: event.turnId!,
        cost: event.payload.totalCostUsd,
        tokens: event.payload.usage
          ? {
              input: event.payload.usage.inputTokens,
              output: event.payload.usage.outputTokens,
            }
          : undefined,
        timestamp: event.createdAt,
      };
    case "session.exited":
      return { type: "session.completed", sessionId, exitCode: null, timestamp: event.createdAt };
    case "request.opened":
      return {
        type: "request.opened",
        sessionId,
        requestId: event.requestId!,
        requestType: event.payload.requestType,
        detail: event.payload.detail,
        timestamp: event.createdAt,
      };
    case "request.resolved":
      return {
        type: "request.resolved",
        sessionId,
        requestId: event.requestId!,
        decision: event.payload.decision ?? "unknown",
        timestamp: event.createdAt,
      };
    default:
      return null;
  }
}
