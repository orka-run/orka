import { z } from "zod/v4";
// Attribution: Push channel protocol inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: wsTransport push/subscribe model

export const PushChannelSchema = z.enum([
  "server.welcome",
  "server.shutdown",
  "orchestration.sessionUpdated",
  "orchestration.sessionDeleted",
  "orchestration.event",
  "session.logLine",
  "fleet.nodeUpdated",
]);

export type PushChannel = z.infer<typeof PushChannelSchema>;

export interface PushEnvelope<T = unknown> {
  type: "push";
  channel: PushChannel;
  sequence: number;
  data: T;
}

export const PROTOCOL_VERSION = 1;

/**
 * Range of protocol versions this client supports.
 * min/max are inclusive. Dashboard embeds this to check against server's protocolVersion.
 */
export const PROTOCOL_VERSION_RANGE = { min: 1, max: 1 } as const;

/**
 * Check whether a server's protocol version is compatible with the given client range.
 *
 * Returns:
 * - `"compatible"` if the server version falls within [min, max]
 * - `"outdated_server"` if the server version is below min (hard mismatch)
 * - `"outdated_client"` if the server version is above max (hard mismatch)
 */
export function isProtocolCompatible(
  serverVersion: number,
  range: { min: number; max: number } = PROTOCOL_VERSION_RANGE,
): "compatible" | "outdated_server" | "outdated_client" {
  if (serverVersion < range.min) return "outdated_server";
  if (serverVersion > range.max) return "outdated_client";
  return "compatible";
}

export const ServerCapabilitiesSchema = z.object({
  resume: z.boolean(),
  encryption: z.union([z.string(), z.literal(false)]),
  multiTurn: z.boolean(),
  adapters: z.array(z.string()),
  maxConcurrent: z.number().int().nonnegative(),
  terminal: z.boolean(),
});

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const ServerWelcomeDataSchema = z.object({
  serverVersion: z.string(),
  sessionCount: z.number().int().nonnegative(),
  protocolVersion: z.number(),
  capabilities: ServerCapabilitiesSchema,
});

export type ServerWelcomeData = z.infer<typeof ServerWelcomeDataSchema>;

export interface SessionUpdatedData {
  sessionId: string;
  status: string;
}

export interface SessionDeletedData {
  sessionId: string;
}

export interface SessionLogLineData {
  sessionId: string;
  content?: string;
  offset?: number;
  line?: string;
}

export const SubscribeRequestSchema = z.object({
  type: z.literal("subscribe"),
  channels: z.array(z.string()),
});

export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

export const UnsubscribeRequestSchema = z.object({
  type: z.literal("unsubscribe"),
  channels: z.array(z.string()),
});

export type UnsubscribeRequest = z.infer<typeof UnsubscribeRequestSchema>;

export const PushControlRequestSchema = z.discriminatedUnion("type", [
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
]);

export type PushControlRequest = z.infer<typeof PushControlRequestSchema>;
