import { z } from "zod/v4";
import {
  CanonicalItemTypeSchema,
  RuntimeContentStreamKindSchema,
  RuntimeItemStatusSchema,
  RuntimeSessionStateSchema,
  RuntimeTurnStateSchema,
} from "./provider-events";
import type {
  CanonicalItemType,
  RuntimeContentStreamKind,
  RuntimeItemStatus,
  RuntimeSessionState,
  RuntimeTurnState,
} from "./provider-events";

interface OrchestrationEventBase {
  v?: number;
  eventId?: string;
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
    }>
  | OrchestrationEventEnvelope<"session.rate_limited", {
      rateLimitType: string;
      resetsAt: number;
      scheduledResumeAt?: string;
      status?: string;
      utilization?: number;
      surpassedThreshold?: number;
      isUsingOverage?: boolean;
    }>
  | OrchestrationEventEnvelope<"session.api_retry", {
      attempt: number;
      maxAttempts: number;
      error: string;
      delayMs: number;
    }>
  | OrchestrationEventEnvelope<"event.passthrough", {
      turnId?: string;
      originalType: string;
      provider?: string;
      rawPayload: unknown;
    }>;

export type PersistedOrchestrationEvent = OrchestrationEvent & {
  provider: string;
  eventId: string;
};

// ---------------------------------------------------------------------------
// Known orchestration event type enum (strict internal set)
// ---------------------------------------------------------------------------

export const KnownOrchestrationEventTypeSchema = z.enum([
  "session.created",
  "session.started",
  "session.state.changed",
  "session.completed",
  "session.failed",
  "session.cancelled",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "user.input",
  "content.delta",
  "item.started",
  "item.updated",
  "item.completed",
  "request.opened",
  "request.resolved",
  "tool.progress",
  "runtime.error",
  "runtime.warning",
  "session.rate_limited",
  "session.api_retry",
  "event.passthrough",
]);

export type KnownOrchestrationEventType = z.infer<typeof KnownOrchestrationEventTypeSchema>;

/** Open-ended event type — accepts any string for forward compatibility. */
export const WireOrchestrationEventTypeSchema = KnownOrchestrationEventTypeSchema.or(z.string());

// ---------------------------------------------------------------------------
// Wire schema — tolerant parsing for data arriving over the network / from DB
// ---------------------------------------------------------------------------

const WireEventBaseSchema = z.object({
  type: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  v: z.number().optional(),
  eventId: z.string().optional(),
}).passthrough();

/** Schema for individual wire event variants (used for type-specific field validation). */
const WireEventVariants: Record<string, z.ZodType> = {
  "session.created": WireEventBaseSchema.extend({
    type: z.literal("session.created"),
    threadId: z.string(),
    backend: z.string(),
  }).passthrough(),

  "session.started": WireEventBaseSchema.extend({
    type: z.literal("session.started"),
  }).passthrough(),

  "session.state.changed": WireEventBaseSchema.extend({
    type: z.literal("session.state.changed"),
    state: RuntimeSessionStateSchema,
    reason: z.string().optional(),
  }).passthrough(),

  "session.completed": WireEventBaseSchema.extend({
    type: z.literal("session.completed"),
    exitCode: z.number().nullable(),
  }).passthrough(),

  "session.failed": WireEventBaseSchema.extend({
    type: z.literal("session.failed"),
    error: z.string(),
  }).passthrough(),

  "session.cancelled": WireEventBaseSchema.extend({
    type: z.literal("session.cancelled"),
    reason: z.string().optional(),
  }).passthrough(),

  "turn.started": WireEventBaseSchema.extend({
    type: z.literal("turn.started"),
    turnId: z.string(),
  }).passthrough(),

  "turn.completed": WireEventBaseSchema.extend({
    type: z.literal("turn.completed"),
    turnId: z.string(),
    state: RuntimeTurnStateSchema.optional(),
    stopReason: z.string().optional(),
    cost: z.number().optional(),
    tokens: z.object({ input: z.number(), output: z.number() }).optional(),
  }).passthrough(),

  "turn.aborted": WireEventBaseSchema.extend({
    type: z.literal("turn.aborted"),
    turnId: z.string(),
    reason: z.string(),
  }).passthrough(),

  "user.input": WireEventBaseSchema.extend({
    type: z.literal("user.input"),
    turnId: z.string().optional(),
    text: z.string(),
  }).passthrough(),

  "content.delta": WireEventBaseSchema.extend({
    type: z.literal("content.delta"),
    turnId: z.string(),
    streamKind: RuntimeContentStreamKindSchema,
    delta: z.string(),
  }).passthrough(),

  "item.started": WireEventBaseSchema.extend({
    type: z.literal("item.started"),
    turnId: z.string(),
    itemId: z.string(),
    itemType: CanonicalItemTypeSchema,
    status: RuntimeItemStatusSchema.optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    args: z.unknown().optional(),
  }).passthrough(),

  "item.updated": WireEventBaseSchema.extend({
    type: z.literal("item.updated"),
    turnId: z.string(),
    itemId: z.string(),
    itemType: CanonicalItemTypeSchema,
    status: RuntimeItemStatusSchema.optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    args: z.unknown().optional(),
  }).passthrough(),

  "item.completed": WireEventBaseSchema.extend({
    type: z.literal("item.completed"),
    turnId: z.string(),
    itemId: z.string(),
    itemType: CanonicalItemTypeSchema,
    status: RuntimeItemStatusSchema.optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    args: z.unknown().optional(),
  }).passthrough(),

  "request.opened": WireEventBaseSchema.extend({
    type: z.literal("request.opened"),
    requestId: z.string(),
    requestType: z.string(),
    detail: z.string().optional(),
  }).passthrough(),

  "request.resolved": WireEventBaseSchema.extend({
    type: z.literal("request.resolved"),
    requestId: z.string(),
    decision: z.string(),
  }).passthrough(),

  "tool.progress": WireEventBaseSchema.extend({
    type: z.literal("tool.progress"),
    turnId: z.string(),
    itemId: z.string().optional(),
    toolName: z.string().optional(),
    summary: z.string().optional(),
    elapsedSeconds: z.number().optional(),
  }).passthrough(),

  "runtime.error": WireEventBaseSchema.extend({
    type: z.literal("runtime.error"),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    error: z.string(),
    class: z.string().optional(),
    terminal: z.boolean().optional(),
  }).passthrough(),

  "runtime.warning": WireEventBaseSchema.extend({
    type: z.literal("runtime.warning"),
    turnId: z.string().optional(),
    itemId: z.string().optional(),
    message: z.string(),
  }).passthrough(),

  "session.rate_limited": WireEventBaseSchema.extend({
    type: z.literal("session.rate_limited"),
    rateLimitType: z.string(),
    resetsAt: z.number(),
    scheduledResumeAt: z.string().optional(),
    status: z.string().optional(),
    utilization: z.number().optional(),
    surpassedThreshold: z.number().optional(),
    isUsingOverage: z.boolean().optional(),
  }).passthrough(),

  "session.api_retry": WireEventBaseSchema.extend({
    type: z.literal("session.api_retry"),
    attempt: z.number(),
    maxAttempts: z.number(),
    error: z.string(),
    delayMs: z.number(),
  }).passthrough(),

  "event.passthrough": WireEventBaseSchema.extend({
    type: z.literal("event.passthrough"),
    turnId: z.string().optional(),
    originalType: z.string(),
    provider: z.string().optional(),
    rawPayload: z.unknown(),
  }).passthrough(),
};

/**
 * Tolerant schema for wire/persisted orchestration events.
 *
 * - Known event types are validated against their specific schema (with `.passthrough()`
 *   so unknown fields are preserved).
 * - Unknown event types pass validation as long as they have the base fields
 *   (`type`, `sessionId`, `timestamp`).
 *
 * Use `safeParse` to avoid throwing on malformed data from the network or DB.
 */
export const WireOrchestrationEventSchema = WireEventBaseSchema.transform((raw) => {
  const variant = WireEventVariants[raw.type];
  if (variant) {
    const result = variant.safeParse(raw);
    if (result.success) return result.data;
    // Known type but variant validation failed — wrap as event.passthrough
    // so downstream consumers don't treat a malformed event as a valid known type.
    const { type: originalType, sessionId, timestamp, v, turnId, ...rest } = raw;
    return {
      type: "event.passthrough",
      sessionId,
      timestamp,
      ...(v !== undefined ? { v } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      originalType,
      rawPayload: rest,
    };
  }
  // Unknown type — return as-is (base-validated)
  return raw;
});

/**
 * Parse a single wire value into a validated wire event shape.
 * Returns `null` if the value does not satisfy the base event envelope.
 */
export function parseWireEvent(value: unknown): OrchestrationEvent | null {
  const result = WireEventBaseSchema.safeParse(value);
  if (!result.success) return null;

  // Run through the full transform for variant-level validation
  const transformed = WireOrchestrationEventSchema.safeParse(value);
  if (!transformed.success) return null;

  return normalizeEvent(transformed.data as Record<string, unknown>);
}

/**
 * Normalize a wire event object into a strict internal `OrchestrationEvent`.
 *
 * - Events with a known `type` are returned as-is (cast to the union).
 * - Events with an unrecognized `type` are wrapped as `event.passthrough`,
 *   preserving the original payload for inspection/debugging.
 * - Applies version migration (sets `v` to 1 if absent).
 */
export function normalizeEvent(wire: Record<string, unknown>): OrchestrationEvent {
  // Apply version migration
  if (typeof wire["v"] !== "number") {
    wire["v"] = 1;
  }

  const eventType = wire["type"] as string;

  // Known type — return as strict OrchestrationEvent
  if (KnownOrchestrationEventTypeSchema.safeParse(eventType).success) {
    return wire as unknown as OrchestrationEvent;
  }

  // Unknown type — wrap as event.passthrough
  const { type: originalType, sessionId, timestamp, v, turnId, ...rest } = wire;
  return {
    v: v as number,
    type: "event.passthrough",
    sessionId: sessionId as string,
    timestamp: timestamp as string,
    ...(turnId !== undefined ? { turnId: turnId as string } : {}),
    originalType: originalType as string,
    rawPayload: rest,
  } as OrchestrationEvent;
}
