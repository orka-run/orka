import type { ServerWebSocket } from "bun";
import type { PushChannel, PushEnvelope } from "@orka/core";
import { withSpanSync } from "./tracing";

export class PushHub {
  private readonly subscribers = new Map<PushChannel, Set<ServerWebSocket<unknown>>>();
  private readonly subscriptions = new Map<ServerWebSocket<unknown>, Set<PushChannel>>();
  private readonly sequences = new Map<ServerWebSocket<unknown>, number>();

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
      this.sequences.delete(ws);
    });
  }

  broadcast<T>(channel: PushChannel, data: T): void {
    withSpanSync("orka.push.broadcast", {
      "orka.channel": channel,
      "orka.subscriber_count": this.subscriberCount(channel),
    }, () => {
      const channelSubscribers = this.subscribers.get(channel);
      if (!channelSubscribers) return;

      for (const ws of channelSubscribers) {
        this.send(ws, channel, data);
      }
    });
  }

  send<T>(ws: ServerWebSocket<unknown>, channel: PushChannel, data: T): void {
    withSpanSync("orka.push.send", { "orka.channel": channel }, () => {
      const envelope: PushEnvelope<T> = {
        type: "push",
        channel,
        sequence: this.nextSequence(ws),
        data,
      };

      ws.send(JSON.stringify(envelope));
    });
  }

  subscriberCount(channel: PushChannel): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }

  private nextSequence(ws: ServerWebSocket<unknown>): number {
    const next = (this.sequences.get(ws) ?? 0) + 1;
    this.sequences.set(ws, next);
    return next;
  }
}
