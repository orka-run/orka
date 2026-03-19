import { propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createOrkaClient } from "./orka-client";

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
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.onmessage?.({ data });
  }
}

const originalWebSocket = globalThis.WebSocket;

let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  trace.disable();
  propagation.disable();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterEach(async () => {
  globalThis.WebSocket = originalWebSocket;
  await provider.shutdown();
  trace.disable();
  propagation.disable();
});

describe("OrkaClient", () => {
  test("includes traceparent in JSON-RPC requests", async () => {
    const client = createOrkaClient("ws://orka.test");
    const resultPromise = client.listSessions();

    const socket = latestSocket();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent).toHaveLength(1);

    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "listSessions",
    });
    expect(request.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: [],
    });

    await expect(resultPromise).resolves.toEqual([]);
    await provider.forceFlush();

    const rpcSpan = exporter.getFinishedSpans().find(
      (span) => span.name === "orka.client.rpc" && span.attributes["orka.method"] === "listSessions",
    );
    expect(rpcSpan).toBeDefined();

    const [, traceId, spanId] = request.traceparent.split("-");
    expect(traceId).toBe(rpcSpan?.spanContext().traceId);
    expect(spanId).toBe(rpcSpan?.spanContext().spanId);

    client.close();
  });

  test("routes requests through the provided node", async () => {
    const client = createOrkaClient("ws://orka.test");
    const resultPromise = client.listSessions(undefined, { node: "node-1" });

    const socket = latestSocket();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "listSessions",
      node: "node-1",
    });

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: [],
    });

    await expect(resultPromise).resolves.toEqual([]);
    client.close();
  });

  test("wraps listSessions filters under params.filters", async () => {
    const client = createOrkaClient("ws://orka.test");
    const resultPromise = client.listSessions({ status: "running" });

    const socket = latestSocket();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "listSessions",
      params: {
        filters: {
          status: "running",
        },
      },
    });

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: [],
    });

    await expect(resultPromise).resolves.toEqual([]);
    client.close();
  });

  test("wraps terminalOpen sizing options under params.opts", async () => {
    const client = createOrkaClient("ws://orka.test");
    const resultPromise = client.terminalOpen("sess-123", { cols: 80, rows: 24 });

    const socket = latestSocket();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "terminalOpen",
      params: {
        sessionId: "sess-123",
        opts: {
          cols: 80,
          rows: 24,
        },
      },
    });

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: { termId: "term-123" },
    });

    await expect(resultPromise).resolves.toEqual({ termId: "term-123" });
    client.close();
  });

  test("wraps workspace updates under params.opts", async () => {
    const client = createOrkaClient("ws://orka.test");
    const resultPromise = client.updateWorkspace("ws-123", { name: "Renamed workspace" });

    const socket = latestSocket();
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = JSON.parse(socket.sent[0] ?? "{}");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "updateWorkspace",
      params: {
        id: "ws-123",
        opts: {
          name: "Renamed workspace",
        },
      },
    });

    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    });

    await expect(resultPromise).resolves.toBeNull();
    client.close();
  });
});

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("expected a websocket instance");
  }
  return socket;
}
