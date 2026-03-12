import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getRelayHome } from "./db";

let _initialized = false;
let _provider: BasicTracerProvider | null = null;

// --- In-memory Metrics ---

interface CounterEntry {
  value: number;
  labels: Record<string, string>;
}

class SimpleCounter {
  private entries = new Map<string, CounterEntry>();

  inc(labels: Record<string, string>, delta: number = 1): void {
    const key = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    const entry = this.entries.get(key);
    if (entry) {
      entry.value += delta;
    } else {
      this.entries.set(key, { value: delta, labels });
    }
  }

  getAll(): CounterEntry[] {
    return [...this.entries.values()];
  }

  reset(): void {
    this.entries.clear();
  }
}

class SimpleHistogram {
  private buckets = new Map<string, number[]>();

  record(labels: Record<string, string>, value: number): void {
    const key = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    let values = this.buckets.get(key);
    if (!values) {
      values = [];
      this.buckets.set(key, values);
    }
    values.push(value);
    // Keep only last 1000 values per bucket to avoid memory growth
    if (values.length > 1000) values.shift();
  }

  getSummary(key: string): { count: number; sum: number; avg: number; p99: number } | null {
    const values = this.buckets.get(key);
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      sum,
      avg: sum / sorted.length,
      p99: sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1] ?? 0,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

class SimpleGauge {
  private values = new Map<string, number>();

  set(labels: Record<string, string>, value: number): void {
    const key = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    this.values.set(key, value);
  }

  inc(labels: Record<string, string>, delta: number = 1): void {
    const key = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  dec(labels: Record<string, string>, delta: number = 1): void {
    const key = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    this.values.set(key, Math.max(0, (this.values.get(key) ?? 0) - delta));
  }

  get(labels: Record<string, string>): number {
    const key = Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    return this.values.get(key) ?? 0;
  }

  getAll(): { labels: string; value: number }[] {
    return [...this.values.entries()].map(([labels, value]) => ({ labels, value }));
  }
}

// --- Metric Instances ---

export const metrics = {
  // Counters
  requestsTotal: new SimpleCounter(),
  bytesIn: new SimpleCounter(),
  bytesOut: new SimpleCounter(),
  connectionsOpened: new SimpleCounter(),
  connectionsClosed: new SimpleCounter(),
  authFailures: new SimpleCounter(),
  rateLimitHits: new SimpleCounter(),
  abuseDetections: new SimpleCounter(),

  // Histograms
  requestDuration: new SimpleHistogram(),
  messageSize: new SimpleHistogram(),

  // Gauges
  activeConnections: new SimpleGauge(),
  registeredNodes: new SimpleGauge(),
  activeAccounts: new SimpleGauge(),
};

// --- File Span Exporter ---

class FileSpanExporter {
  private _logFile: string;

  constructor(logFile?: string) {
    const dir = getRelayHome();
    mkdirSync(dir, { recursive: true });
    this._logFile = logFile ?? join(dir, "traces.jsonl");
  }

  export(spans: any[], resultCallback: (result: any) => void): void {
    for (const span of spans) {
      const entry = {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanId || undefined,
        name: span.name,
        kind: span.kind,
        startTime: hrTimeToMs(span.startTime),
        endTime: hrTimeToMs(span.endTime),
        durationMs: hrTimeToMs(span.endTime) - hrTimeToMs(span.startTime),
        status: span.status,
        attributes: span.attributes,
        events: span.events.map((e: any) => ({
          name: e.name,
          time: hrTimeToMs(e.time),
          attributes: e.attributes,
        })),
      };
      try {
        appendFileSync(this._logFile, JSON.stringify(entry) + "\n");
      } catch {
        // Don't crash if we can't write
      }
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

// --- Init / Shutdown ---

export function initRelayTracing(opts?: { traceFile?: string }): void {
  if (_initialized) return;
  _initialized = true;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "orka-relay",
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  const processors: any[] = [];

  // Always write to file
  processors.push(new SimpleSpanProcessor(new FileSpanExporter(opts?.traceFile) as any));

  // Console exporter when ORKA_TRACE=console
  if (process.env["ORKA_TRACE"] === "console") {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  _provider = new BasicTracerProvider({
    resource,
    spanProcessors: processors,
  });

  trace.setGlobalTracerProvider(_provider);
}

export async function shutdownRelayTracing(): Promise<void> {
  if (_provider) {
    await _provider.shutdown();
  }
}

export function getTracer(): Tracer {
  return trace.getTracer("orka-relay", "0.1.0");
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => T,
): T {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
