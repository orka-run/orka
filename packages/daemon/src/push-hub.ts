import type { ServerWebSocket } from "bun";
import type { PushChannel, PushEnvelope } from "@orka/core";
import { withSpanSync } from "./tracing";

const SEND_BUFFER_WARNING_THRESHOLD = 256 * 1024;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getSessionId(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const sessionId = (data as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

export class PushHub {
  private readonly subscribers = new Map<PushChannel, Set<ServerWebSocket<unknown>>>();
  private readonly subscriptions = new Map<ServerWebSocket<unknown>, Set<PushChannel>>();
  private readonly directSequences = new Map<ServerWebSocket<unknown>, number>();
  private readonly broadcastSequences = new Map<PushChannel, number>();

  subscribe(ws: ServerWebSocket<unknown>, channels: PushChannel[]): void {
    withSpanSync("orka.push.subscribe", { "orka.channel.count": channels.length }, () => {
      let subscribedChannels = this.subscriptions.get(ws);
      if (!subscribedChannels) {
        subscribedChannels = new Set<PushChannel>();
        this.subscriptions.set(ws, subscribedChannels);
      }

      for (const channel of channels) {
        subscribedChannels.add(channel);

        let channelSubscribers = this.subscribers.get(channel);
        if (!channelSubscribers) {
          channelSubscribers = new Set<ServerWebSocket<unknown>>();
          this.subscribers.set(channel, channelSubscribers);
        }

        channelSubscribers.add(ws);
      }
    });
  }

  unsubscribe(ws: ServerWebSocket<unknown>, channels: PushChannel[]): void {
    withSpanSync("orka.push.unsubscribe", { "orka.channel.count": channels.length }, () => {
      const subscribedChannels = this.subscriptions.get(ws);
      if (!subscribedChannels) return;

      for (const channel of channels) {
        subscribedChannels.delete(channel);

        const channelSubscribers = this.subscribers.get(channel);
        if (!channelSubscribers) continue;

        channelSubscribers.delete(ws);
        if (channelSubscribers.size === 0) {
          this.subscribers.delete(channel);
        }
      }

      if (subscribedChannels.size === 0) {
        this.subscriptions.delete(ws);
      }
    });
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    withSpanSync("orka.push.remove_client", {}, () => {
      const subscribedChannels = this.subscriptions.get(ws);
      if (subscribedChannels) {
        for (const channel of subscribedChannels) {
          const channelSubscribers = this.subscribers.get(channel);
          if (!channelSubscribers) continue;

          channelSubscribers.delete(ws);
          if (channelSubscribers.size === 0) {
            this.subscribers.delete(channel);
          }
        }
      }

      this.subscriptions.delete(ws);
      this.directSequences.delete(ws);
    });
  }

  broadcast<T>(channel: PushChannel, data: T): void {
    const sequence = this.nextBroadcastSequence(channel);
    const sessionId = getSessionId(data);
    withSpanSync("orka.push.broadcast", {
      "orka.channel": channel,
      "orka.sequence": sequence,
      "orka.subscriber_count": this.subscriberCount(channel),
      ...(sessionId ? { "orka.session.id": sessionId } : {}),
    }, (span) => {
      const channelSubscribers = this.subscribers.get(channel);
      if (!channelSubscribers) return;

      let subscriberIndex = 0;
      for (const ws of channelSubscribers) {
        const startedAt = now();
        this.send(ws, channel, data, sequence);
        const bufferedAmount = ws.getBufferedAmount();
        const eventAttributes: Record<string, string | number | boolean> = {
          "orka.channel": channel,
          "orka.sequence": sequence,
          "orka.subscriber.index": subscriberIndex++,
          "orka.duration_ms": Math.max(0, now() - startedAt),
          "orka.buffered_amount": bufferedAmount,
        };
        if (sessionId) {
          eventAttributes["orka.session.id"] = sessionId;
        }

        span.addEvent("push.subscriber_sent", eventAttributes);
        if (bufferedAmount > SEND_BUFFER_WARNING_THRESHOLD) {
          span.addEvent("push.send_buffer_warning", {
            ...eventAttributes,
            "orka.buffer_threshold": SEND_BUFFER_WARNING_THRESHOLD,
          });
        }
      }
    });
  }

  send<T>(
    ws: ServerWebSocket<unknown>,
    channel: PushChannel,
    data: T,
    sequence = this.nextDirectSequence(ws),
  ): PushEnvelope<T> {
    return withSpanSync("orka.push.send", { "orka.channel": channel, "orka.sequence": sequence }, () => {
      const envelope: PushEnvelope<T> = {
        type: "push",
        channel,
        sequence,
        data,
      };

      ws.send(JSON.stringify(envelope));
      return envelope;
    });
  }

  subscriberCount(channel: PushChannel): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }

  private nextDirectSequence(ws: ServerWebSocket<unknown>): number {
    const next = (this.directSequences.get(ws) ?? 0) + 1;
    this.directSequences.set(ws, next);
    return next;
  }

  private nextBroadcastSequence(channel: PushChannel): number {
    const next = (this.broadcastSequences.get(channel) ?? 0) + 1;
    this.broadcastSequences.set(channel, next);
    return next;
  }
}
