import { z } from "zod/v4";

// Attribution: Push channel protocol inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: wsTransport push/subscribe model

export const PushChannelSchema = z.enum([
  "server.welcome",
  "server.shutdown",
  "orchestration.sessionUpdated",
  "orchestration.sessionDeleted",
  "orchestration.event",
]);

export type PushChannel = z.infer<typeof PushChannelSchema>;

export interface PushEnvelope<T = unknown> {
  type: "push";
  channel: PushChannel;
  sequence: number;
  data: T;
}

export interface ServerWelcomeData {
  serverVersion: string;
  sessionCount: number;
}

export interface SessionUpdatedData {
  sessionId: string;
  status: string;
}

export interface SessionDeletedData {
  sessionId: string;
}

export const SubscribeRequestSchema = z.object({
  type: z.literal("subscribe"),
  channels: z.array(PushChannelSchema),
});

export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

export const UnsubscribeRequestSchema = z.object({
  type: z.literal("unsubscribe"),
  channels: z.array(PushChannelSchema),
});

export type UnsubscribeRequest = z.infer<typeof UnsubscribeRequestSchema>;

export const PushControlRequestSchema = z.discriminatedUnion("type", [
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
]);

export type PushControlRequest = z.infer<typeof PushControlRequestSchema>;
