import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { OrkaService, Session } from "@orka/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pushHub } from "./push";
import { handleRpcRequest } from "./rpc-handler";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    taskId: "task-1",
    workspaceId: "ws-1",
    status: "running",
    backend: "codex",
    mode: "interactive",
    tmuxSessionName: "orka-sess-1",
    projectPath: "/tmp/project",
    workingDir: "/tmp/project",
    logFile: "/tmp/logs/sess-1.log",
    createdAt: "2026-03-11T10:00:00.000Z",
    startedAt: "2026-03-11T10:00:01.000Z",
    finishedAt: null,
    exitCode: null,
    kept: false,
    autoMerge: false,
    ...overrides,
  };
}

describe("handleRpcRequest", () => {
  const originalBroadcast = pushHub.broadcast.bind(pushHub);
  let events: Array<{ channel: string; data: unknown }>;

  beforeEach(() => {
    events = [];
    (pushHub as { broadcast: typeof pushHub.broadcast }).broadcast = ((channel, data) => {
      events.push({ channel, data });
    }) as typeof pushHub.broadcast;
  });

  afterEach(() => {
    (pushHub as { broadcast: typeof pushHub.broadcast }).broadcast = originalBroadcast;
  });

  test("broadcasts session updates after spawn", async () => {
    const session = makeSession();
    const svc = {
      async spawn() {
        return session;
      },
    } as OrkaService;

    const response = await handleRpcRequest(
      svc,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "spawn", params: {} }),
    );

    expect(JSON.parse(response)).toMatchObject({
      id: 1,
      result: { id: session.id, status: session.status },
    });
    expect(events).toEqual([
      {
        channel: "orchestration.sessionUpdated",
        data: { sessionId: session.id, status: session.status },
      },
    ]);
  });

  test("broadcasts session updates after stop", async () => {
    const session = makeSession({ status: "cancelled", finishedAt: "2026-03-11T10:05:00.000Z" });
    let stoppedSessionId: string | null = null;
    const svc = {
      async stop(sessionId: string) {
        stoppedSessionId = sessionId;
      },
      async getSession(sessionId: string) {
        return sessionId === session.id ? session : null;
      },
    } as OrkaService;

    const response = await handleRpcRequest(
      svc,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "stop", params: { sessionId: session.id } }),
    );

    expect(stoppedSessionId).toBe(session.id);
    expect(JSON.parse(response)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: null,
    });
    expect(events).toEqual([
      {
        channel: "orchestration.sessionUpdated",
        data: { sessionId: session.id, status: "cancelled" },
      },
    ]);
  });

  test("broadcasts session deletions after deleteSessions", async () => {
    const deletedIds: string[][] = [];
    const svc = {
      async deleteSessions(ids: string[]) {
        deletedIds.push(ids);
      },
    } as OrkaService;

    const response = await handleRpcRequest(
      svc,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "deleteSessions",
        params: { ids: ["sess-1", "sess-2"] },
      }),
    );

    expect(deletedIds).toEqual([["sess-1", "sess-2"]]);
    expect(JSON.parse(response)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: null,
    });
    expect(events).toEqual([
      {
        channel: "orchestration.sessionDeleted",
        data: { sessionId: "sess-1" },
      },
      {
        channel: "orchestration.sessionDeleted",
        data: { sessionId: "sess-2" },
      },
    ]);
  });

  test("creates a child span from the caller traceparent", async () => {
    trace.disable();
    propagation.disable();

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    try {
      const svc = {
        async reap() {
          return 1;
        },
      } as OrkaService;

      const tracer = trace.getTracer("rpc-handler-test");
      let traceparent = "";

      await tracer.startActiveSpan("caller", async (callerSpan) => {
        const carrier: { traceparent?: string } = {};
        propagation.inject(trace.setSpan(context.active(), callerSpan), carrier);
        traceparent = carrier.traceparent ?? "";

        const response = await handleRpcRequest(
          svc,
          JSON.stringify({ jsonrpc: "2.0", id: 4, method: "reap", traceparent }),
        );

        expect(JSON.parse(response)).toEqual({
          jsonrpc: "2.0",
          id: 4,
          result: 1,
        });

        callerSpan.end();
      });

      await provider.forceFlush();

      const callerSpan = exporter.getFinishedSpans().find((span) => span.name === "caller");
      const rpcSpan = exporter.getFinishedSpans().find((span) => span.name === "orka.rpc.handle");

      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      expect(callerSpan).toBeDefined();
      expect(rpcSpan).toBeDefined();
      expect(rpcSpan?.spanContext().traceId).toBe(callerSpan?.spanContext().traceId);
      expect(rpcSpan?.parentSpanContext?.spanId).toBe(callerSpan?.spanContext().spanId);
    } finally {
      await provider.shutdown();
      trace.disable();
      propagation.disable();
    }
  });
});
