/**
 * Shared test helpers for daemon unit tests.
 *
 * - withTestTracing: in-memory OTel tracing (no file I/O, no env mutation)
 * - seedSession: consolidated session+task seeder
 * - initTracingForTest: shortcut to disable file export
 */

import { propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SessionStatus } from "@orka/core";
import type { DatabaseRepository } from "./db";
import { initTracing } from "./tracing";

/**
 * Run a function with an isolated in-memory OTel tracing setup.
 * No file I/O, no env mutation. Cleans up after itself.
 */
export async function withTestTracing(
  fn: (ctx: { exporter: InMemorySpanExporter; provider: BasicTracerProvider }) => Promise<void>,
): Promise<void> {
  trace.disable();
  propagation.disable();

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  try {
    await fn({ exporter, provider });
    await provider.forceFlush();
  } finally {
    await provider.shutdown();
    trace.disable();
    propagation.disable();
  }
}

/**
 * Seed a task + session into the database.
 * Consolidates the 5 duplicated implementations across test files.
 */
export function seedSession(
  db: DatabaseRepository,
  sessionId: string,
  opts?: {
    status?: SessionStatus;
    workspaceId?: string;
    noWorktree?: boolean;
    workingDir?: string;
    projectPath?: string;
    taskId?: string;
  },
): void {
  const taskId = opts?.taskId ?? `task-${sessionId}`;
  db.insertTask({
    id: taskId,
    title: `Task ${sessionId}`,
    prompt: "test prompt",
    backend: "claude-code",
    model: "claude-sonnet",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  db.insertSession({
    id: sessionId,
    taskId,
    workspaceId: opts?.workspaceId ?? "",
    status: (opts?.status ?? "completed") as any,
    backend: "claude-code",
    projectPath: opts?.projectPath ?? "/tmp/project",
    workingDir: opts?.workingDir ?? "/tmp/project",
    logFile: `/tmp/${sessionId}.log`,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:02:00.000Z",
    exitCode: 0,
    kept: false,
    autoMerge: false,
    ...(opts?.noWorktree != null ? { noWorktree: opts.noWorktree } : {}),
  });
}

/**
 * Initialize tracing with file export disabled.
 * Use this in tests that don't need to read trace files.
 */
export function initTracingForTest(): void {
  initTracing({ disableFileExporter: true });
}
