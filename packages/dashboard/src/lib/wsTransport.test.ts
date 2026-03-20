import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { rpcLatencyStore } from "./rpcLatencyStore";
import { createDashboardTransport } from "./wsTransport";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
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
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
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
const originalDateNow = Date.now;

let timerId = 0;
let scheduledTimers: ScheduledTimer[] = [];
let provider: WebTracerProvider;
let exporter: InMemorySpanExporter;
let currentTime = 0;

/** Install MockWebSocket as the global WebSocket constructor for testing. */
function installMockWebSocket(): void {
  // MockWebSocket covers the subset of the WebSocket API that WsTransport uses.
  // Full browser WebSocket has extra methods (addEventListener, etc.) that are unused.
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
}

/** Install deterministic timer stubs for testing reconnect delays. */
function installMockTimers(): void {
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
    // Timer IDs are plain numbers in this mock but Timeout objects in Node types
    return timer.id as unknown as ReturnType<typeof originalSetTimeout>;
  }) as unknown as typeof originalSetTimeout;
  globalThis.clearTimeout = ((timeoutId: ReturnType<typeof originalSetTimeout>) => {
    const timer = scheduledTimers.find((entry) => entry.id === Number(timeoutId));
    if (timer) {
      timer.cleared = true;
    }
  }) as typeof originalClearTimeout;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  scheduledTimers = [];
  timerId = 0;
  currentTime = 0;
  rpcLatencyStore.reset();

  installMockWebSocket();
  installMockTimers();
  Date.now = () => currentTime;

  exporter = new InMemorySpanExporter();
  provider = new WebTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterEach(async () => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalDateNow;
  rpcLatencyStore.reset();
  await provider.shutdown();
  trace.disable();
  propagation.disable();
});

describe("WsTransport", () => {
  test("request() sends JSON-RPC and resolves on response", async () => {
    const transport = createDashboardTransport("ws://orka.test");
    transport.connect();

    const socket = latestSocket();
    socket.open();

    const resultPromise = transport.request<string>("listSessions", { filter: "all" });
    advanceTime(12);

    expect(socket.sent).toHaveLength(1);
    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "listSessions",
      params: { filter: "all" },
    });
    expect(request.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: "ok",
    });

    await expect(resultPromise).resolves.toBe("ok");
    expect(rpcLatencyStore.getLastRtt("listSessions")).toBe(12);
    expect(rpcLatencyStore.getConnectionRtt()).toBe(12);
    expect(rpcLatencyStore.getMethodStats("listSessions")).toMatchObject({
      avg: 12,
      p95: 12,
      p99: 12,
      min: 12,
      max: 12,
      count: 1,
    });
    const rpcSpan = exporter.getFinishedSpans().find(
      (span) => span.name === "orka.client.rpc" && span.attributes["orka.method"] === "listSessions",
    );
    expect(rpcSpan).toBeDefined();
    expect(rpcSpan?.attributes["orka.status"]).toBe("ok");

    const [, traceId, spanId] = request.traceparent.split("-");
    expect(traceId).toBe(rpcSpan?.spanContext().traceId);
    expect(spanId).toBe(rpcSpan?.spanContext().spanId);
  });

  test("request() rejects on timeout", async () => {
    const transport = createDashboardTransport("ws://orka.test", { timeout: 5 });
    transport.connect();

    const socket = latestSocket();
    socket.open();

    const resultPromise = transport.request("listSessions");
    advanceTime(5);
    runTimer(5);

    await expect(resultPromise).rejects.toThrow("Request timeout: listSessions");
    expect(socket.sent).toHaveLength(1);
    expect(rpcLatencyStore.getLastRtt("listSessions")).toBe(5);
    expect(rpcLatencyStore.getConnectionRtt()).toBe(5);

    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "listSessions",
    });
    expect(request.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const rpcSpan = exporter.getFinishedSpans().find(
      (span) => span.name === "orka.client.rpc" && span.attributes["orka.method"] === "listSessions",
    );
    expect(rpcSpan?.attributes["orka.status"]).toBe("timeout");
    expect(rpcLatencyStore.getMethodStats("listSessions")).toMatchObject({
      avg: 5,
      p95: 5,
      p99: 5,
      min: 5,
      max: 5,
      count: 1,
    });
    expect(rpcLatencyStore.getLastRtt("listSessions")).toBe(5);
  });

  test("records latency stats for error responses", async () => {
    const transport = createDashboardTransport("ws://orka.test");
    transport.connect();

    const socket = latestSocket();
    socket.open();

    const resultPromise = transport.request("listSessions");

    currentTime = 18;
    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "boom" },
    });

    await expect(resultPromise).rejects.toThrow("boom");
    expect(rpcLatencyStore.getMethodStats("listSessions")).toMatchObject({
      avg: 18,
      p95: 18,
      p99: 18,
      min: 18,
      max: 18,
      count: 1,
    });
    expect(rpcLatencyStore.getLastRtt("listSessions")).toBe(18);
    expect(rpcLatencyStore.getConnectionRtt()).toBe(18);
  });

  test("tracks per-method latency stats across successful and failed responses", async () => {
    const transport = createDashboardTransport("ws://orka.test");
    transport.connect();

    const socket = latestSocket();
    socket.open();

    const successPromise = transport.request<string>("listSessions");
    advanceTime(12);
    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: "ok",
    });
    await expect(successPromise).resolves.toBe("ok");

    const failedPromise = transport.request("listSessions");
    advanceTime(8);
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message: "boom",
      },
    });
    await expect(failedPromise).rejects.toThrow("boom");

    expect(rpcLatencyStore.getLastRtt("listSessions")).toBe(8);
    expect(rpcLatencyStore.getConnectionRtt()).toBe(8);
    expect(rpcLatencyStore.getMethodStats("listSessions")).toMatchObject({
      avg: 10,
      p95: 12,
      p99: 12,
      min: 8,
      max: 12,
      count: 2,
    });
    expect(rpcLatencyStore.getAllStats()).toMatchObject({
      listSessions: {
        avg: 10,
        p95: 12,
        p99: 12,
        min: 8,
        max: 12,
        count: 2,
      },
    });
  });

  test("subscribe() registers handler and receives push messages", () => {
    const transport = createDashboardTransport("ws://orka.test");
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

  test("reports push sequence gaps over RPC", () => {
    const transport = createDashboardTransport("ws://orka.test");

    transport.connect();
    const socket = latestSocket();
    socket.open();

    transport.subscribe("orchestration.sessionUpdated", () => {});

    socket.receive({
      type: "push",
      channel: "orchestration.sessionUpdated",
      sequence: 8,
      data: { sessionId: "sess-1", status: "running" },
    });
    socket.receive({
      type: "push",
      channel: "orchestration.sessionUpdated",
      sequence: 10,
      data: { sessionId: "sess-1", status: "completed" },
    });

    expect(socket.sent).toHaveLength(2);
    const gapReport = JSON.parse(socket.sent[1] ?? "{}");
    expect(gapReport).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "reportEventGap",
      params: {
        channel: "orchestration.sessionUpdated",
        expectedSeq: 9,
        gotSeq: 10,
      },
    });
  });

  test("records push handler latency on the connection span", () => {
    const transport = createDashboardTransport("ws://orka.test");

    transport.connect();
    const socket = latestSocket();
    socket.open();

    transport.subscribe("orchestration.event", () => {});
    socket.receive({
      type: "push",
      channel: "orchestration.event",
      sequence: 4,
      data: { sessionId: "sess-1" },
    });

    transport.disconnect();

    const connectionSpan = exporter.getFinishedSpans().find((span) => span.name === "orka.client.ws");
    const handledEvent = connectionSpan?.events.find((event) => event.name === "push.handlers_completed");

    expect(connectionSpan).toBeDefined();
    expect(handledEvent).toBeDefined();
    expect(handledEvent?.attributes?.["orka.channel"]).toBe("orchestration.event");
    expect(handledEvent?.attributes?.["orka.sequence"]).toBe(4);
    expect(handledEvent?.attributes?.["orka.handler_count"]).toBe(1);
    expect(Number(handledEvent?.attributes?.["orka.duration_ms"])).toBeGreaterThanOrEqual(0);
  });

  test("subscribe() replays latest cached value for new subscribers", () => {
    const transport = createDashboardTransport("ws://orka.test");
    transport.connect();

    const socket = latestSocket();
    socket.open();
    socket.receive({
      type: "push",
      channel: "server.welcome",
      sequence: 7,
      data: {
        serverVersion: "0.0.1",
        sessionCount: 2,
        protocolVersion: 1,
        capabilities: {
          resume: false,
          encryption: false,
          multiTurn: true,
          adapters: ["claude-code", "codex"],
          maxConcurrent: 0,
          terminal: true,
        },
      },
    });

    const received: Array<{ data: unknown; sequence: number }> = [];
    transport.subscribe("server.welcome", (data, sequence) => {
      received.push({ data, sequence });
    });

    expect(received).toEqual([
      {
        data: {
          serverVersion: "0.0.1",
          sessionCount: 2,
          protocolVersion: 1,
          capabilities: {
            resume: false,
            encryption: false,
            multiTurn: true,
            adapters: ["claude-code", "codex"],
            maxConcurrent: 0,
            terminal: true,
          },
        },
        sequence: 7,
      },
    ]);
  });

  test("reconnects on close with exponential backoff", () => {
    const transport = createDashboardTransport("ws://orka.test");
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

  test("reports reconnect attempt counts to state listeners", () => {
    const transport = createDashboardTransport("ws://orka.test");
    const updates: Array<{ state: string; reconnectAttempts: number }> = [];

    transport.onStateChange((snapshot) => {
      updates.push(snapshot);
    });

    transport.connect();

    const firstSocket = latestSocket();
    firstSocket.open();
    firstSocket.close();

    runTimer(500);

    const secondSocket = latestSocket();
    secondSocket.close();

    expect(updates).toEqual([
      { state: "connecting", reconnectAttempts: 0 },
      { state: "connected", reconnectAttempts: 0 },
      { state: "reconnecting", reconnectAttempts: 1 },
      { state: "reconnecting", reconnectAttempts: 2 },
    ]);
  });

  test("outbox messages queued while disconnected are sent on reconnect", async () => {
    const transport = createDashboardTransport("ws://orka.test");
    transport.connect();

    const firstSocket = latestSocket();
    firstSocket.open();
    firstSocket.close();

    const resultPromise = transport.request<string>("listSessions");
    expect(firstSocket.sent).toEqual([]);

    runTimer(500);

    const secondSocket = latestSocket();
    secondSocket.open();

    expect(secondSocket.sent).toHaveLength(1);
    expect(JSON.parse(secondSocket.sent[0] ?? "{}")).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "listSessions",
    });

    secondSocket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: "reconnected",
    });

    await expect(resultPromise).resolves.toBe("reconnected");
  });

  test("unsubscribe() removes handler", () => {
    const transport = createDashboardTransport("ws://orka.test");
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
  return scheduledTimers.filter((timer) => !timer.cleared && timer.delay > 0).map((timer) => timer.delay);
}

function runTimer(delay: number): void {
  const timer = scheduledTimers.find((entry) => !entry.cleared && entry.delay === delay);
  if (!timer) {
    throw new Error(`Expected timer with delay ${delay}`);
  }

  timer.cleared = true;
  timer.callback();
}

function advanceTime(deltaMs: number): void {
  currentTime += deltaMs;
}
