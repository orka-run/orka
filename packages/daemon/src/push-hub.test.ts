import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { PushHub } from "./push-hub";

function createMockWs() {
  const sent: string[] = [];
  return {
    send(data: string) {
      sent.push(data);
    },
    sent,
  };
}

function asServerWebSocket(ws: ReturnType<typeof createMockWs>): ServerWebSocket<unknown> {
  return ws as unknown as ServerWebSocket<unknown>;
}

describe("PushHub", () => {
  test("broadcasts only to subscribed clients", () => {
    const hub = new PushHub();
    const subscribed = createMockWs();
    const unsubscribed = createMockWs();

    hub.subscribe(asServerWebSocket(subscribed), ["orchestration.event"]);
    hub.broadcast("orchestration.event", { sessionId: "sess-1" });

    expect(subscribed.sent).toHaveLength(1);
    expect(JSON.parse(subscribed.sent[0])).toEqual({
      type: "push",
      channel: "orchestration.event",
      sequence: 1,
      data: { sessionId: "sess-1" },
    });
    expect(unsubscribed.sent).toHaveLength(0);
    expect(hub.subscriberCount("orchestration.event")).toBe(1);
  });

  test("unsubscribe stops future broadcasts", () => {
    const hub = new PushHub();
    const ws = createMockWs();
    const client = asServerWebSocket(ws);

    hub.subscribe(client, ["orchestration.sessionUpdated"]);
    hub.unsubscribe(client, ["orchestration.sessionUpdated"]);
    hub.broadcast("orchestration.sessionUpdated", { sessionId: "sess-1", status: "running" });

    expect(ws.sent).toHaveLength(0);
    expect(hub.subscriberCount("orchestration.sessionUpdated")).toBe(0);
  });

  test("removeClient clears all subscriptions", () => {
    const hub = new PushHub();
    const ws = createMockWs();
    const client = asServerWebSocket(ws);

    hub.subscribe(client, ["orchestration.event", "orchestration.sessionDeleted"]);
    hub.removeClient(client);
    hub.broadcast("orchestration.event", { sessionId: "sess-1" });
    hub.broadcast("orchestration.sessionDeleted", { sessionId: "sess-1" });

    expect(ws.sent).toHaveLength(0);
    expect(hub.subscriberCount("orchestration.event")).toBe(0);
    expect(hub.subscriberCount("orchestration.sessionDeleted")).toBe(0);
  });

  test("increments sequence numbers per client across direct sends and broadcasts", () => {
    const hub = new PushHub();
    const ws = createMockWs();
    const client = asServerWebSocket(ws);

    hub.subscribe(client, ["orchestration.event"]);
    hub.send(client, "server.welcome", { serverVersion: "0.0.1", sessionCount: 2 });
    hub.broadcast("orchestration.event", { sessionId: "sess-1" });
    hub.send(client, "orchestration.sessionDeleted", { sessionId: "sess-1" });

    expect(ws.sent.map((message) => JSON.parse(message).sequence)).toEqual([1, 2, 3]);
  });
});
