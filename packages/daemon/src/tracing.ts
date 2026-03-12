import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type AttributeValue,
  type Attributes,
  type Context,
  type HrTime,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getOrkaHome } from "./db";

export type LogLevel = "debug" | "info" | "warn" | "error";

let _initialized = false;
let _provider: BasicTracerProvider | null = null;

export function setLogLevel(_level: LogLevel): void {
  // Reserved for future use with structured logging alongside tracing
}

export interface TracingInitOptions {
  otlpHttpEndpoint?: string;
  otlpFallbackToFile?: boolean;
  disableFileExporter?: boolean;
  serviceName?: string;
  serviceVersion?: string;
}

export interface TraceLogEntry {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: {
    code?: number;
    message?: string;
  };
  attributes: Record<string, unknown>;
  resourceAttributes?: Record<string, unknown>;
  instrumentationScope?: {
    name?: string;
    version?: string;
  };
  events: Array<{
    name: string;
    time: number;
    attributes?: Record<string, unknown>;
  }>;
}

export function getTraceLogPath(): string {
  const dir = getOrkaHome();
  mkdirSync(dir, { recursive: true });
  return join(dir, "traces.jsonl");
}

export interface TraceQuery {
  /** Filter by service name (e.g. "orka-dashboard") */
  service?: string;
  /** Only return error spans (status.code === 2) */
  errorsOnly?: boolean;
  /** Filter by span name pattern (substring match) */
  namePattern?: string;
  /** Maximum number of results (default 50) */
  limit?: number;
  /** Only spans after this ISO timestamp */
  since?: string;
}

export function queryTraceLog(query: TraceQuery = {}): TraceLogEntry[] {
  const logPath = getTraceLogPath();
  const limit = query.limit ?? 50;
  const sinceMs = query.since ? new Date(query.since).getTime() : 0;
  const results: TraceLogEntry[] = [];

  let fd: number;
  let fileSize: number;
  try {
    fd = openSync(logPath, "r");
    fileSize = fstatSync(fd).size;
    if (fileSize === 0) { closeSync(fd); return []; }

    // Read from end in 256KB chunks
    const CHUNK_SIZE = 256 * 1024;
    let tail = "";
    let offset = fileSize;

    while (offset > 0 && results.length < limit) {
      const readStart = Math.max(0, offset - CHUNK_SIZE);
      const readLen = offset - readStart;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, readStart);
      const combined = buf.toString("utf8") + tail;
      const lines = combined.split("\n");

      // First element may be partial — carry to next chunk
      tail = lines[0];

      for (let i = lines.length - 1; i >= 1 && results.length < limit; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        let entry: TraceLogEntry;
        try { entry = JSON.parse(line); } catch { continue; }

        if (sinceMs && entry.startTime < sinceMs) continue;
        if (query.errorsOnly && entry.status.code !== 2) continue;
        if (query.namePattern && !entry.name.includes(query.namePattern)) continue;
        if (query.service && entry.resourceAttributes?.["service.name"] !== query.service) continue;

        results.push(entry);
      }

      offset = readStart;
    }

    // Process remaining tail (first line of file)
    if (results.length < limit && tail.trim()) {
      try {
        const entry: TraceLogEntry = JSON.parse(tail.trim());
        const ok =
          (!sinceMs || entry.startTime >= sinceMs) &&
          (!query.errorsOnly || entry.status.code === 2) &&
          (!query.namePattern || entry.name.includes(query.namePattern)) &&
          (!query.service || entry.resourceAttributes?.["service.name"] === query.service);
        if (ok) results.push(entry);
      } catch { /* skip */ }
    }

    closeSync(fd);
  } catch {
    return results;
  }

  return results;
}

function appendTraceLogEntries(entries: TraceLogEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  const logFile = getTraceLogPath();
  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  appendFileSync(logFile, payload);
}

export function serializeReadableSpan(span: ReadableSpan): TraceLogEntry {
  const startTime = hrTimeToMs(span.startTime);
  const endTime = hrTimeToMs(span.endTime);

  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: span.kind,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    status: span.status,
    attributes: attributesToJson(span.attributes),
    resourceAttributes: attributesToJson(span.resource.attributes),
    instrumentationScope: {
      name: span.instrumentationScope.name,
      ...(span.instrumentationScope.version ? { version: span.instrumentationScope.version } : {}),
    },
    events: span.events.map((event) => ({
      name: event.name,
      time: hrTimeToMs(event.time),
      attributes: attributesToJson(event.attributes),
    })),
  };
}

/** Custom exporter that writes spans as JSON lines to ~/.orka/traces.jsonl */
class FileSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      appendTraceLogEntries(spans.map(serializeReadableSpan));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

class OtlpHttpSpanExporter implements SpanExporter {
  constructor(
    private readonly endpoint: string,
    private readonly fallbackExporter: SpanExporter | null,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    void this.exportBatch(spans, resultCallback);
  }

  private async exportBatch(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(serializeSpansToOtlpJson(spans)),
      });

      if (!response.ok) {
        throw new Error(`Collector returned ${response.status}`);
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      if (this.fallbackExporter) {
        this.fallbackExporter.export(spans, resultCallback);
        return;
      }

      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function hrTimeToMs(hrTime: HrTime): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/** Initialize OpenTelemetry tracing. Call once at startup. */
export function initTracing(options: TracingInitOptions = {}): void {
  if (_initialized) return;
  _initialized = true;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName ?? "orka",
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.1.0",
  });

  const processors: SimpleSpanProcessor[] = [];
  const fileExporter = new FileSpanExporter();

  if (options.otlpHttpEndpoint) {
    processors.push(
      new SimpleSpanProcessor(
        new OtlpHttpSpanExporter(
          options.otlpHttpEndpoint,
          options.otlpFallbackToFile === false ? null : fileExporter,
        ),
      ),
    );
  } else if (!options.disableFileExporter) {
    processors.push(new SimpleSpanProcessor(fileExporter));
  }

  if (process.env["ORKA_TRACE"] === "console") {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  _provider = new BasicTracerProvider({
    resource,
    spanProcessors: processors,
  });

  trace.setGlobalTracerProvider(_provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

/** Shutdown tracing — flush pending spans. */
export async function shutdownTracing(): Promise<void> {
  if (_provider) {
    await _provider.shutdown();
    _provider = null;
  }
  trace.disable();
  propagation.disable();
  _initialized = false;
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
  parentContext?: Context,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, parentContext ?? context.active(), async (span) => {
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

export function persistOtlpJsonTraces(payload: unknown): void {
  appendTraceLogEntries(parseOtlpJsonTraceEntries(payload));
}

function serializeSpansToOtlpJson(spans: ReadableSpan[]): { resourceSpans: Array<Record<string, unknown>> } {
  return {
    resourceSpans: spans.map((span) => ({
      resource: {
        attributes: attributesToOtlp(span.resource.attributes),
      },
      scopeSpans: [
        {
          scope: {
            name: span.instrumentationScope.name,
            version: span.instrumentationScope.version,
          },
          spans: [serializeSpanToOtlp(span)],
        },
      ],
    })),
  };
}

function serializeSpanToOtlp(span: ReadableSpan): Record<string, unknown> {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: hrTimeToUnixNanos(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanos(span.endTime),
    attributes: attributesToOtlp(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: hrTimeToUnixNanos(event.time),
      attributes: attributesToOtlp(event.attributes),
    })),
    status: {
      code: span.status.code,
      ...(span.status.message ? { message: span.status.message } : {}),
    },
  };
}

function hrTimeToUnixNanos(hrTime: HrTime): string {
  return (BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1])).toString();
}

function attributesToJson(attributes: Attributes | undefined): Record<string, unknown> {
  if (!attributes) {
    return {};
  }

  const entries = Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined);
  return Object.fromEntries(
    entries.map(([key, value]) => [key, attributeValueToJson(value)]),
  );
}

function attributesToOtlp(attributes: Attributes | undefined): Array<Record<string, unknown>> {
  if (!attributes) {
    return [];
  }

  return Object.entries(attributes)
    .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
    .map(([key, value]) => ({
      key,
      value: attributeValueToOtlp(value),
    }));
}

function attributeValueToJson(value: AttributeValue): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string | number | boolean => entry !== undefined && entry !== null);
  }
  return value;
}

function attributeValueToOtlp(value: AttributeValue): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value
          .filter((entry): entry is string | number | boolean => entry !== undefined && entry !== null)
          .map(attributeArrayValueToOtlp),
      },
    };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  return { stringValue: String(value) };
}

function attributeArrayValueToOtlp(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Number.isInteger(value)) {
    return { intValue: String(value) };
  }
  return { doubleValue: value };
}

function parseOtlpJsonTraceEntries(payload: unknown): TraceLogEntry[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const resourceSpans = (payload as { resourceSpans?: unknown }).resourceSpans;
  if (!Array.isArray(resourceSpans)) {
    return [];
  }

  const entries: TraceLogEntry[] = [];

  for (const resourceSpan of resourceSpans) {
    if (!resourceSpan || typeof resourceSpan !== "object") {
      continue;
    }

    const resource = (resourceSpan as { resource?: { attributes?: unknown } }).resource;
    const resourceAttributes = otlpAttributesToJson(resource?.attributes);
    const scopeSpans =
      (resourceSpan as { scopeSpans?: unknown; instrumentationLibrarySpans?: unknown }).scopeSpans ??
      (resourceSpan as { instrumentationLibrarySpans?: unknown }).instrumentationLibrarySpans;

    if (!Array.isArray(scopeSpans)) {
      continue;
    }

    for (const scopeSpan of scopeSpans) {
      if (!scopeSpan || typeof scopeSpan !== "object") {
        continue;
      }

      const spans = (scopeSpan as { spans?: unknown }).spans;
      if (!Array.isArray(spans)) {
        continue;
      }

      const scope =
        (scopeSpan as { scope?: { name?: unknown; version?: unknown }; instrumentationLibrary?: { name?: unknown; version?: unknown } }).scope ??
        (scopeSpan as { instrumentationLibrary?: { name?: unknown; version?: unknown } }).instrumentationLibrary;

      for (const span of spans) {
        if (!span || typeof span !== "object") {
          continue;
        }

        const spanRecord = span as Record<string, unknown>;
        const startTime = unixNanosToMs(spanRecord["startTimeUnixNano"]);
        const endTime = unixNanosToMs(spanRecord["endTimeUnixNano"]);
        const status = spanRecord["status"] && typeof spanRecord["status"] === "object"
          ? spanRecord["status"] as Record<string, unknown>
          : {};
        const scopeName = typeof scope?.name === "string" ? scope.name : undefined;
        const scopeVersion = typeof scope?.version === "string" ? scope.version : undefined;

        const statusCode = parseStatusCode(status["code"]);

        entries.push({
          traceId: typeof spanRecord["traceId"] === "string" ? spanRecord["traceId"] : "",
          spanId: typeof spanRecord["spanId"] === "string" ? spanRecord["spanId"] : "",
          ...(typeof spanRecord["parentSpanId"] === "string" ? { parentSpanId: spanRecord["parentSpanId"] } : {}),
          name: typeof spanRecord["name"] === "string" ? spanRecord["name"] : "unknown",
          kind: typeof spanRecord["kind"] === "number" ? spanRecord["kind"] : 0,
          startTime,
          endTime,
          durationMs: Math.max(0, endTime - startTime),
          status: {
            ...(statusCode !== undefined ? { code: statusCode } : {}),
            ...(typeof status["message"] === "string" ? { message: status["message"] } : {}),
          },
          attributes: otlpAttributesToJson(spanRecord["attributes"]),
          resourceAttributes,
          instrumentationScope: {
            ...(scopeName ? { name: scopeName } : {}),
            ...(scopeVersion ? { version: scopeVersion } : {}),
          },
          events: Array.isArray(spanRecord["events"])
            ? spanRecord["events"]
                .filter((event): event is Record<string, unknown> => !!event && typeof event === "object")
                .map((event) => ({
                  name: typeof event["name"] === "string" ? event["name"] : "event",
                  time: unixNanosToMs(event["timeUnixNano"]),
                  attributes: otlpAttributesToJson(event["attributes"]),
                }))
            : [],
        });
      }
    }
  }

  return entries;
}

function unixNanosToMs(value: unknown): number {
  if (typeof value === "bigint") {
    return Number(value / 1_000_000n);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value / 1_000_000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return Number(BigInt(value) / 1_000_000n);
    } catch {
      return 0;
    }
  }
  return 0;
}

function otlpAttributesToJson(attributes: unknown): Record<string, unknown> {
  if (!Array.isArray(attributes)) {
    return {};
  }

  return Object.fromEntries(
    attributes
      .filter((attribute): attribute is { key?: unknown; value?: unknown } => !!attribute && typeof attribute === "object")
      .filter((attribute) => typeof attribute.key === "string")
      .map((attribute) => [attribute.key as string, otlpValueToJson(attribute.value)]),
  );
}

function otlpValueToJson(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;

  if (typeof record["stringValue"] === "string") {
    return record["stringValue"];
  }
  if (typeof record["boolValue"] === "boolean") {
    return record["boolValue"];
  }
  if (typeof record["doubleValue"] === "number") {
    return record["doubleValue"];
  }
  if (record["intValue"] !== undefined) {
    const numeric = Number(record["intValue"]);
    return Number.isFinite(numeric) ? numeric : record["intValue"];
  }
  if (
    record["arrayValue"] &&
    typeof record["arrayValue"] === "object" &&
    Array.isArray((record["arrayValue"] as { values?: unknown }).values)
  ) {
    return ((record["arrayValue"] as { values: unknown[] }).values).map(otlpValueToJson);
  }
  if (record["kvlistValue"] && typeof record["kvlistValue"] === "object") {
    return otlpAttributesToJson((record["kvlistValue"] as { values?: unknown }).values);
  }
  return record["bytesValue"] ?? null;
}

function parseStatusCode(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "STATUS_CODE_OK" || value === "OK") {
      return SpanStatusCode.OK;
    }
    if (value === "STATUS_CODE_ERROR" || value === "ERROR") {
      return SpanStatusCode.ERROR;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}
