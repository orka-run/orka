import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WsTransport } from "./wsTransport";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("Socket is not open");
    }

    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }

    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }

    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.onmessage?.({ data });
  }
}

type ScheduledTimer = {
  id: number;
  delay: number;
  callback: () => void;
  cleared: boolean;
};

const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let timerId = 0;
let scheduledTimers: ScheduledTimer[] = [];

beforeEach(() => {
  MockWebSocket.instances = [];
  scheduledTimers = [];
  timerId = 0;

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
    const callback = () => {
      if (typeof handler === "function") {
        handler();
      }
    };

    const timer: ScheduledTimer = {
      id: ++timerId,
      delay: Number(delay ?? 0),
      callback,
      cleared: false,
    };
    scheduledTimers.push(timer);
    return timer.id as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timeoutId: ReturnType<typeof setTimeout>) => {
    const timer = scheduledTimers.find((entry) => entry.id === Number(timeoutId));
    if (timer) {
      timer.cleared = true;
    }
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe("WsTransport", () => {
  test("request() sends JSON-RPC and resolves on response", async () => {
    const transport = new WsTransport("ws://orka.test");
    transport.connect();

    const socket = latestSocket();
    socket.open();

    const resultPromise = transport.request<string>("listSessions", { filter: "all" });

    expect(socket.sent).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "listSessions",
        params: { filter: "all" },
      }),
    ]);

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: "ok",
    });

    await expect(resultPromise).resolves.toBe("ok");
  });

  test("request() rejects on timeout", async () => {
    const transport = new WsTransport("ws://orka.test", { timeout: 5 });
    transport.connect();

    const socket = latestSocket();
    socket.open();

    const resultPromise = transport.request("listSessions");

    runTimer(5);

    await expect(resultPromise).rejects.toThrow("Request timeout: listSessions");
    expect(socket.sent).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "listSessions",
      }),
    ]);
  });

  test("subscribe() registers handler and receives push messages", () => {
    const transport = new WsTransport("ws://orka.test");
    const received: Array<{ data: unknown; sequence: number }> = [];

    transport.connect();
    const socket = latestSocket();
    socket.open();

    transport.subscribe("orchestration.sessionUpdated", (data, sequence) => {
      received.push({ data, sequence });
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "subscribe",
        channels: ["orchestration.sessionUpdated"],
      }),
    ]);

    socket.receive({
      type: "push",
      channel: "orchestration.sessionUpdated",
      sequence: 3,
      data: { sessionId: "sess-1", status: "running" },
    });

    expect(received).toEqual([
      {
        data: { sessionId: "sess-1", status: "running" },
        sequence: 3,
      },
    ]);
  });

  test("subscribe() replays latest cached value for new subscribers", () => {
    const transport = new WsTransport("ws://orka.test");
    transport.connect();

    const socket = latestSocket();
    socket.open();
    socket.receive({
      type: "push",
      channel: "server.welcome",
      sequence: 7,
      data: { serverVersion: "0.0.1", sessionCount: 2 },
    });

    const received: Array<{ data: unknown; sequence: number }> = [];
    transport.subscribe("server.welcome", (data, sequence) => {
      received.push({ data, sequence });
    });

    expect(received).toEqual([
      {
        data: { serverVersion: "0.0.1", sessionCount: 2 },
        sequence: 7,
      },
    ]);
  });

  test("reconnects on close with exponential backoff", () => {
    const transport = new WsTransport("ws://orka.test");
    transport.connect();

    const firstSocket = latestSocket();
    firstSocket.open();
    firstSocket.close();

    expect(transport.connectionState).toBe("reconnecting");
    expect(pendingDelays()).toEqual([500]);

    runTimer(500);

    const secondSocket = latestSocket();
    expect(secondSocket).not.toBe(firstSocket);

    secondSocket.close();
    expect(pendingDelays()).toEqual([1_000]);
  });

  test("outbox messages queued while disconnected are sent on reconnect", async () => {
    const transport = new WsTransport("ws://orka.test");
    transport.connect();

    const firstSocket = latestSocket();
    firstSocket.open();
    firstSocket.close();

    const resultPromise = transport.request<string>("listSessions");
    expect(firstSocket.sent).toEqual([]);

    runTimer(500);

    const secondSocket = latestSocket();
    secondSocket.open();

    expect(secondSocket.sent).toEqual([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "listSessions",
      }),
    ]);

    secondSocket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: "reconnected",
    });

    await expect(resultPromise).resolves.toBe("reconnected");
  });

  test("unsubscribe() removes handler", () => {
    const transport = new WsTransport("ws://orka.test");
    const received: Array<{ data: unknown; sequence: number }> = [];

    transport.connect();
    const socket = latestSocket();
    socket.open();

    const unsubscribe = transport.subscribe("orchestration.event", (data, sequence) => {
      received.push({ data, sequence });
    });
    unsubscribe();

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "subscribe",
        channels: ["orchestration.event"],
      }),
      JSON.stringify({
        type: "unsubscribe",
        channels: ["orchestration.event"],
      }),
    ]);

    socket.receive({
      type: "push",
      channel: "orchestration.event",
      sequence: 4,
      data: { sessionId: "sess-1" },
    });

    expect(received).toEqual([]);
  });
});

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("Expected a WebSocket instance");
  }

  return socket;
}

function pendingDelays(): number[] {
  return scheduledTimers.filter((timer) => !timer.cleared).map((timer) => timer.delay);
}

function runTimer(delay: number): void {
  const timer = scheduledTimers.find((entry) => !entry.cleared && entry.delay === delay);
  if (!timer) {
    throw new Error(`Expected timer with delay ${delay}`);
  }

  timer.cleared = true;
  timer.callback();
}
