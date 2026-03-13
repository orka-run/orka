// Event taxonomy inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: packages/contracts/src/providerRuntime.ts

import { z } from "zod/v4";
import { BackendKindSchema, generateId, type BackendKind } from "./types";

export const ProviderKindSchema = BackendKindSchema;
export type ProviderKind = BackendKind;

export const KnownCanonicalItemTypeSchema = z.enum([
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
export type KnownCanonicalItemType = z.infer<typeof KnownCanonicalItemTypeSchema>;
export const CanonicalItemTypeSchema = KnownCanonicalItemTypeSchema.or(z.string());
export type CanonicalItemType = z.infer<typeof CanonicalItemTypeSchema>;
export function isKnownCanonicalItemType(v: string): v is KnownCanonicalItemType {
  return KnownCanonicalItemTypeSchema.safeParse(v).success;
}

export const KnownCanonicalRequestTypeSchema = z.enum([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "tool_user_input",
  "unknown",
]);
export type KnownCanonicalRequestType = z.infer<typeof KnownCanonicalRequestTypeSchema>;
export const CanonicalRequestTypeSchema = KnownCanonicalRequestTypeSchema.or(z.string());
export type CanonicalRequestType = z.infer<typeof CanonicalRequestTypeSchema>;
export function isKnownCanonicalRequestType(v: string): v is KnownCanonicalRequestType {
  return KnownCanonicalRequestTypeSchema.safeParse(v).success;
}

export const KnownRuntimeSessionStateSchema = z.enum(["starting", "ready", "running", "waiting", "stopped", "error"]);
export type KnownRuntimeSessionState = z.infer<typeof KnownRuntimeSessionStateSchema>;
export const RuntimeSessionStateSchema = KnownRuntimeSessionStateSchema.or(z.string());
export type RuntimeSessionState = z.infer<typeof RuntimeSessionStateSchema>;
export function isKnownRuntimeSessionState(v: string): v is KnownRuntimeSessionState {
  return KnownRuntimeSessionStateSchema.safeParse(v).success;
}

export const KnownRuntimeTurnStateSchema = z.enum(["completed", "failed", "interrupted", "cancelled"]);
export type KnownRuntimeTurnState = z.infer<typeof KnownRuntimeTurnStateSchema>;
export const RuntimeTurnStateSchema = KnownRuntimeTurnStateSchema.or(z.string());
export type RuntimeTurnState = z.infer<typeof RuntimeTurnStateSchema>;
export function isKnownRuntimeTurnState(v: string): v is KnownRuntimeTurnState {
  return KnownRuntimeTurnStateSchema.safeParse(v).success;
}

export const KnownRuntimeItemStatusSchema = z.enum(["in_progress", "completed", "failed", "declined"]);
export type KnownRuntimeItemStatus = z.infer<typeof KnownRuntimeItemStatusSchema>;
export const RuntimeItemStatusSchema = KnownRuntimeItemStatusSchema.or(z.string());
export type RuntimeItemStatus = z.infer<typeof RuntimeItemStatusSchema>;
export function isKnownRuntimeItemStatus(v: string): v is KnownRuntimeItemStatus {
  return KnownRuntimeItemStatusSchema.safeParse(v).success;
}

export const KnownRuntimeContentStreamKindSchema = z.enum([
  "assistant_text",
  "reasoning_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type KnownRuntimeContentStreamKind = z.infer<typeof KnownRuntimeContentStreamKindSchema>;
export const RuntimeContentStreamKindSchema = KnownRuntimeContentStreamKindSchema.or(z.string());
export type RuntimeContentStreamKind = z.infer<typeof RuntimeContentStreamKindSchema>;
export function isKnownRuntimeContentStreamKind(v: string): v is KnownRuntimeContentStreamKind {
  return KnownRuntimeContentStreamKindSchema.safeParse(v).success;
}

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
