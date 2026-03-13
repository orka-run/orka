// Event taxonomy inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: packages/contracts/src/providerRuntime.ts

import { z } from "zod/v4";
import { BackendKindSchema, generateId, type BackendKind } from "./types";

export const ProviderKindSchema = BackendKindSchema;
export type ProviderKind = BackendKind;

export const CanonicalItemTypeSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "file_read",
  "search",
  "web",
  "agent",
  "mcp_tool_call",
  "error",
  "unknown",
]);
export type CanonicalItemType = z.infer<typeof CanonicalItemTypeSchema>;

export const CanonicalRequestTypeSchema = z.enum([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "tool_user_input",
  "unknown",
]);
export type CanonicalRequestType = z.infer<typeof CanonicalRequestTypeSchema>;

export const RuntimeSessionStateSchema = z.enum(["starting", "ready", "running", "waiting", "stopped", "error"]);
export type RuntimeSessionState = z.infer<typeof RuntimeSessionStateSchema>;

export const RuntimeTurnStateSchema = z.enum(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = z.infer<typeof RuntimeTurnStateSchema>;

export const RuntimeItemStatusSchema = z.enum(["in_progress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = z.infer<typeof RuntimeItemStatusSchema>;

export const RuntimeContentStreamKindSchema = z.enum([
  "assistant_text",
  "reasoning_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type RuntimeContentStreamKind = z.infer<typeof RuntimeContentStreamKindSchema>;

export interface ProviderRuntimeEventBase {
  v?: number;
  eventId: string;
  provider: BackendKind;
  threadId: string;
  createdAt: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
}

export interface SessionStartedPayload {
  message?: string;
}

export interface SessionStateChangedPayload {
  state: RuntimeSessionState;
  reason?: string;
}

export interface SessionExitedPayload {
  reason?: string;
  exitKind?: "graceful" | "error";
}

export interface TurnStartedPayload {
  model?: string;
}

export interface TurnCompletedPayload {
  state: RuntimeTurnState;
  stopReason?: string;
  totalCostUsd?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface TurnAbortedPayload {
  reason: string;
}

export interface ItemLifecyclePayload {
  itemType: CanonicalItemType;
  status?: RuntimeItemStatus;
  title?: string;
  detail?: string;
  /** Full tool input arguments (e.g. old_string/new_string for Edit, command for Bash). */
  args?: unknown;
}

export interface ContentDeltaPayload {
  streamKind: RuntimeContentStreamKind;
  delta: string;
}

export interface RequestOpenedPayload {
  requestType: CanonicalRequestType;
  detail?: string;
  args?: unknown;
}

export interface RequestResolvedPayload {
  requestType: CanonicalRequestType;
  decision?: string;
}

export interface ToolProgressPayload {
  toolName?: string;
  summary?: string;
  elapsedSeconds?: number;
}

export interface RuntimeWarningPayload {
  message: string;
}

export interface RuntimeErrorPayload {
  message: string;
  class?: "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown";
}

interface ProviderRuntimeEventEnvelope<TType extends string, TPayload> extends ProviderRuntimeEventBase {
  type: TType;
  payload: TPayload;
}

export type SessionStartedEvent = ProviderRuntimeEventEnvelope<"session.started", SessionStartedPayload>;
export type SessionStateChangedEvent = ProviderRuntimeEventEnvelope<"session.state.changed", SessionStateChangedPayload>;
export type SessionExitedEvent = ProviderRuntimeEventEnvelope<"session.exited", SessionExitedPayload>;
export type TurnStartedEvent = ProviderRuntimeEventEnvelope<"turn.started", TurnStartedPayload>;
export type TurnCompletedEvent = ProviderRuntimeEventEnvelope<"turn.completed", TurnCompletedPayload>;
export type TurnAbortedEvent = ProviderRuntimeEventEnvelope<"turn.aborted", TurnAbortedPayload>;
export type ItemStartedEvent = ProviderRuntimeEventEnvelope<"item.started", ItemLifecyclePayload>;
export type ItemUpdatedEvent = ProviderRuntimeEventEnvelope<"item.updated", ItemLifecyclePayload>;
export type ItemCompletedEvent = ProviderRuntimeEventEnvelope<"item.completed", ItemLifecyclePayload>;
export type ContentDeltaEvent = ProviderRuntimeEventEnvelope<"content.delta", ContentDeltaPayload>;
export type RequestOpenedEvent = ProviderRuntimeEventEnvelope<"request.opened", RequestOpenedPayload>;
export type RequestResolvedEvent = ProviderRuntimeEventEnvelope<"request.resolved", RequestResolvedPayload>;
export type ToolProgressEvent = ProviderRuntimeEventEnvelope<"tool.progress", ToolProgressPayload>;
export type RuntimeErrorEvent = ProviderRuntimeEventEnvelope<"runtime.error", RuntimeErrorPayload>;
export type RuntimeWarningEvent = ProviderRuntimeEventEnvelope<"runtime.warning", RuntimeWarningPayload>;

export type ProviderRuntimeEvent =
  | SessionStartedEvent
  | SessionStateChangedEvent
  | SessionExitedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnAbortedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ContentDeltaEvent
  | RequestOpenedEvent
  | RequestResolvedEvent
  | ToolProgressEvent
  | RuntimeErrorEvent
  | RuntimeWarningEvent;

export interface ProviderRuntimeEventPayloads {
  "session.started": SessionStartedPayload;
  "session.state.changed": SessionStateChangedPayload;
  "session.exited": SessionExitedPayload;
  "turn.started": TurnStartedPayload;
  "turn.completed": TurnCompletedPayload;
  "turn.aborted": TurnAbortedPayload;
  "item.started": ItemLifecyclePayload;
  "item.updated": ItemLifecyclePayload;
  "item.completed": ItemLifecyclePayload;
  "content.delta": ContentDeltaPayload;
  "request.opened": RequestOpenedPayload;
  "request.resolved": RequestResolvedPayload;
  "tool.progress": ToolProgressPayload;
  "runtime.error": RuntimeErrorPayload;
  "runtime.warning": RuntimeWarningPayload;
}

export type ProviderRuntimeEventType = keyof ProviderRuntimeEventPayloads;
export type ProviderRuntimeEventOf<TType extends ProviderRuntimeEventType> = Extract<ProviderRuntimeEvent, { type: TType }>;

export interface CreateProviderRuntimeEventOptions {
  eventId?: string;
  provider?: BackendKind;
  createdAt?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
}

const DEFAULT_PROVIDER: BackendKind = BackendKindSchema.options[0] ?? "claude-code";

export function createEvent<TType extends ProviderRuntimeEventType>(
  type: TType,
  threadId: string,
  payload: ProviderRuntimeEventPayloads[TType],
  opts: CreateProviderRuntimeEventOptions = {},
): ProviderRuntimeEventOf<TType> {
  return {
    v: 1,
    eventId: opts.eventId ?? generateId("evt"),
    provider: opts.provider ?? DEFAULT_PROVIDER,
    threadId,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    turnId: opts.turnId,
    itemId: opts.itemId,
    requestId: opts.requestId,
    type,
    payload,
  } as ProviderRuntimeEventOf<TType>;
}
