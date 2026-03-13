import type {
  CanonicalItemType,
  RuntimeContentStreamKind,
  RuntimeItemStatus,
  RuntimeSessionState,
  RuntimeTurnState,
} from "./provider-events";

interface OrchestrationEventBase {
  v?: number;
  sessionId: string;
  timestamp: string;
}

type OrchestrationEventEnvelope<TType extends string, TPayload extends object = {}> =
  OrchestrationEventBase & { type: TType } & TPayload;

export type OrchestrationEvent =
  | OrchestrationEventEnvelope<"session.created", {
      threadId: string;
      backend: string;
    }>
  | OrchestrationEventEnvelope<"session.started">
  | OrchestrationEventEnvelope<"session.state.changed", {
      state: RuntimeSessionState;
      reason?: string;
    }>
  | OrchestrationEventEnvelope<"session.completed", {
      exitCode: number | null;
    }>
  | OrchestrationEventEnvelope<"session.failed", {
      error: string;
    }>
  | OrchestrationEventEnvelope<"session.cancelled", {
      reason?: string;
    }>
  | OrchestrationEventEnvelope<"turn.started", {
      turnId: string;
    }>
  | OrchestrationEventEnvelope<"turn.completed", {
      turnId: string;
      state?: RuntimeTurnState;
      stopReason?: string;
      cost?: number;
      tokens?: {
        input: number;
        output: number;
      };
    }>
  | OrchestrationEventEnvelope<"turn.aborted", {
      turnId: string;
      reason: string;
    }>
  | OrchestrationEventEnvelope<"user.input", {
      turnId?: string;
      text: string;
    }>
  | OrchestrationEventEnvelope<"content.delta", {
      turnId: string;
      streamKind: RuntimeContentStreamKind;
      delta: string;
    }>
  | OrchestrationEventEnvelope<"item.started", {
      turnId: string;
      itemId: string;
      itemType: CanonicalItemType;
      status?: RuntimeItemStatus;
      title?: string;
      detail?: string;
      args?: unknown;
    }>
  | OrchestrationEventEnvelope<"item.updated", {
      turnId: string;
      itemId: string;
      itemType: CanonicalItemType;
      status?: RuntimeItemStatus;
      title?: string;
      detail?: string;
      args?: unknown;
    }>
  | OrchestrationEventEnvelope<"item.completed", {
      turnId: string;
      itemId: string;
      itemType: CanonicalItemType;
      status?: RuntimeItemStatus;
      title?: string;
      detail?: string;
      args?: unknown;
    }>
  | OrchestrationEventEnvelope<"request.opened", {
      requestId: string;
      requestType: string;
      detail?: string;
    }>
  | OrchestrationEventEnvelope<"request.resolved", {
      requestId: string;
      decision: string;
    }>
  | OrchestrationEventEnvelope<"tool.progress", {
      turnId: string;
      itemId?: string;
      toolName?: string;
      summary?: string;
      elapsedSeconds?: number;
    }>
  | OrchestrationEventEnvelope<"runtime.error", {
      turnId?: string;
      itemId?: string;
      error: string;
      class?: "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown";
      terminal?: boolean;
    }>
  | OrchestrationEventEnvelope<"runtime.warning", {
      turnId?: string;
      itemId?: string;
      message: string;
    }>;

export type PersistedOrchestrationEvent = OrchestrationEvent & {
  provider: string;
  eventId: string;
};
