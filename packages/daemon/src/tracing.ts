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
import { getOrkaHome } from "./db";

export type LogLevel = "debug" | "info" | "warn" | "error";

let _initialized = false;
let _provider: BasicTracerProvider | null = null;

export function setLogLevel(_level: LogLevel): void {
  // Reserved for future use with structured logging alongside tracing
}

/** Custom exporter that writes spans as JSON lines to ~/.orka/traces.jsonl */
class FileSpanExporter {
  private _logFile: string;

  constructor() {
    const dir = getOrkaHome();
    mkdirSync(dir, { recursive: true });
    this._logFile = join(dir, "traces.jsonl");
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

/** Initialize OpenTelemetry tracing. Call once at startup. */
export function initTracing(): void {
  if (_initialized) return;
  _initialized = true;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "orka",
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  const processors: any[] = [];

  // Always write to file
  processors.push(new SimpleSpanProcessor(new FileSpanExporter() as any));

  // Console exporter when ORKA_TRACE=console
  if (process.env.ORKA_TRACE === "console") {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  _provider = new BasicTracerProvider({
    resource,
    spanProcessors: processors,
  });

  trace.setGlobalTracerProvider(_provider);

}

/** Shutdown tracing — flush pending spans. */
export async function shutdownTracing(): Promise<void> {
  if (_provider) {
    await _provider.shutdown();
  }
}

/** Get the orka tracer. */
export function getTracer(): Tracer {
  return trace.getTracer("orka", "0.1.0");
}

/**
 * Run a function within a traced span. Automatically sets error status on throw.
 */
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

/**
 * Synchronous version of withSpan for non-async operations.
 */
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
