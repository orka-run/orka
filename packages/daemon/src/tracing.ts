import {
  context,
  metrics,
  propagation,
  trace,
  SpanStatusCode,
  type AttributeValue,
  type Attributes,
  type Counter,
  type Context,
  type Histogram,
  type HrTime,
  type Meter,
  type Span,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

let _initialized = false;
let _tracerProvider: BasicTracerProvider | null = null;
let _meterProvider: MeterProvider | null = null;
let _metricSnapshotExporter: InMemoryMetricExporter | null = null;
let _daemonMetrics: DaemonMetrics | null = null;

const OTEL_EXPORT_INTERVAL_MS = 15_000;
const OTEL_EXPORT_TIMEOUT_MS = 10_000;

export interface DaemonMetrics {
  sessionsSpawned: Counter;
  sessionsCompleted: Counter;
  sessionsFailed: Counter;
  sessionsCancelled: Counter;
  rpcRequests: Counter;
  rpcErrors: Counter;
  pushEvents: Counter;
  rpcDuration: Histogram;
  sessionDuration: Histogram;
  sessionsActive: UpDownCounter;
  wsConnections: UpDownCounter;
}

export interface MetricSnapshot {
  resourceAttributes: Record<string, unknown>;
  scopeMetrics: Array<{
    scope: {
      name?: string;
      version?: string;
    };
    metrics: Array<{
      name: string;
      description: string;
      unit: string;
      dataPointType: string;
      aggregationTemporality: string;
      isMonotonic?: boolean;
      dataPoints: Array<{
        startTime: number;
        endTime: number;
        attributes: Record<string, unknown>;
        value: unknown;
      }>;
    }>;
  }>;
}

export function setLogLevel(_level: LogLevel): void {
  // Reserved for future use with structured logging alongside tracing
}

export interface TracingInitOptions {
  otlpHttpEndpoint?: string;
  otlpFallbackToFile?: boolean;
  disableFileExporter?: boolean;
  serviceName?: string;
  serviceVersion?: string;
  /** Explicit data directory for trace files. When omitted, falls back to ORKA_HOME env / ~/.orka. */
  dataDir?: string;
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

export function queryTraceLog(query: TraceQuery = {}, dataDir: string): TraceLogEntry[] {
  const logPath = join(dataDir, "traces.jsonl");
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
      tail = lines[0] ?? "";

      for (let i = lines.length - 1; i >= 1 && results.length < limit; i--) {
        const line = lines[i]?.trim();
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

const TRACE_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const TRACE_FILE_MAX_COMPRESSED = 5; // Keep up to 5 compressed archives

// TODO: use streaming compression (Bun.file(src).stream() → zstd transform → Bun.write(dst))
// to avoid reading entire 50MB file into memory at once
function compressWithZstdAsync(src: string, dst: string): void {
  Bun.file(src).arrayBuffer().then((buf) =>
    Bun.zstdCompress(new Uint8Array(buf)),
  ).then((compressed) => {
    writeFileSync(dst, compressed);
    unlinkSync(src);
  }).catch(() => {
    // Compression failed — keep uncompressed as fallback
    try { renameSync(src, dst.replace(/\.zst$/, "")); } catch { /* ignore */ }
  });
}

function rotateTraceFileIfNeeded(logFile: string): void {
  try {
    const size = statSync(logFile).size;
    if (size < TRACE_FILE_MAX_BYTES) return;
  } catch {
    return; // File doesn't exist yet
  }

  // Remove oldest compressed archive
  try { unlinkSync(`${logFile}.${TRACE_FILE_MAX_COMPRESSED}.zst`); } catch { /* doesn't exist */ }
  try { unlinkSync(`${logFile}.${TRACE_FILE_MAX_COMPRESSED}`); } catch { /* uncompressed fallback */ }

  // Shift existing archives
  for (let i = TRACE_FILE_MAX_COMPRESSED; i >= 2; i--) {
    // Try .zst first, then uncompressed
    for (const ext of [".zst", ""]) {
      try {
        renameSync(`${logFile}.${i - 1}${ext}`, `${logFile}.${i}${ext}`);
        break;
      } catch { /* doesn't exist */ }
    }
  }

  // Compress current file to .1.zst
  renameSync(logFile, `${logFile}.rotating`);
  compressWithZstdAsync(`${logFile}.rotating`, `${logFile}.1.zst`);
}

function appendTraceLogEntries(entries: TraceLogEntry[], dataDir: string): void {
  if (entries.length === 0) {
    return;
  }

  const logFile = join(dataDir, "traces.jsonl");
  mkdirSync(dataDir, { recursive: true });
  rotateTraceFileIfNeeded(logFile);
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
  constructor(private readonly dataDir: string) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      appendTraceLogEntries(spans.map(serializeReadableSpan), this.dataDir);
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

class OtlpHttpMetricExporter implements PushMetricExporter {
  constructor(
    private readonly endpoint: string,
    private readonly fallbackExporter: PushMetricExporter | null,
  ) {}

  export(resourceMetrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    void this.exportBatch(resourceMetrics, resultCallback);
  }

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  private async exportBatch(
    resourceMetrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(serializeMetricsToOtlpJson(resourceMetrics)),
      });

      if (!response.ok) {
        throw new Error(`Collector returned ${response.status}`);
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      if (this.fallbackExporter) {
        this.fallbackExporter.export(resourceMetrics, resultCallback);
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

  if (!options.dataDir && !options.disableFileExporter) throw new Error("initTracing requires dataDir when file exporter is enabled");

  const traceEndpoint = options.otlpHttpEndpoint ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const metricEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName ?? "orka",
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.1.0",
  });

  const processors: SimpleSpanProcessor[] = [];
  const fileExporter = new FileSpanExporter(options.dataDir ?? "");

  if (traceEndpoint) {
    processors.push(
      new SimpleSpanProcessor(
        new OtlpHttpSpanExporter(
          normalizeOtlpHttpEndpoint(traceEndpoint, "traces"),
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

  _tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: processors,
  });
  trace.setGlobalTracerProvider(_tracerProvider);

  const metricReaders = [];
  _metricSnapshotExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReaders.push(new PeriodicExportingMetricReader({
    exporter: _metricSnapshotExporter,
    exportIntervalMillis: OTEL_EXPORT_INTERVAL_MS,
    exportTimeoutMillis: OTEL_EXPORT_TIMEOUT_MS,
  }));

  if (metricEndpoint) {
    metricReaders.push(new PeriodicExportingMetricReader({
      exporter: new OtlpHttpMetricExporter(
        normalizeOtlpHttpEndpoint(metricEndpoint, "metrics"),
        process.env["ORKA_TRACE"] === "console" ? new ConsoleMetricExporter() : null,
      ),
      exportIntervalMillis: OTEL_EXPORT_INTERVAL_MS,
      exportTimeoutMillis: OTEL_EXPORT_TIMEOUT_MS,
    }));
  } else if (process.env["ORKA_TRACE"] === "console") {
    metricReaders.push(new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
      exportIntervalMillis: OTEL_EXPORT_INTERVAL_MS,
      exportTimeoutMillis: OTEL_EXPORT_TIMEOUT_MS,
    }));
  }

  _meterProvider = new MeterProvider({
    resource,
    readers: metricReaders,
  });
  metrics.setGlobalMeterProvider(_meterProvider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

/** Shutdown tracing — flush pending spans. */
export async function shutdownTracing(): Promise<void> {
  if (_meterProvider) {
    await _meterProvider.shutdown();
    _meterProvider = null;
  }
  if (_tracerProvider) {
    await _tracerProvider.shutdown();
    _tracerProvider = null;
  }
  trace.disable();
  metrics.disable();
  propagation.disable();
  _metricSnapshotExporter = null;
  _daemonMetrics = null;
  _initialized = false;
}

/** Get the orka tracer. */
export function getTracer(): Tracer {
  return trace.getTracer("orka", "0.1.0");
}

/** Get the orka meter. */
export function getMeter(): Meter {
  return metrics.getMeter("orka", "0.1.0");
}

export function getDaemonMetrics(): DaemonMetrics {
  if (_daemonMetrics) {
    return _daemonMetrics;
  }

  const meter = getMeter();
  _daemonMetrics = {
    sessionsSpawned: meter.createCounter("orka.sessions.spawned", {
      description: "Total number of daemon sessions started.",
    }),
    sessionsCompleted: meter.createCounter("orka.sessions.completed", {
      description: "Total number of sessions that completed successfully.",
    }),
    sessionsFailed: meter.createCounter("orka.sessions.failed", {
      description: "Total number of sessions that ended in failure.",
    }),
    sessionsCancelled: meter.createCounter("orka.sessions.cancelled", {
      description: "Total number of sessions cancelled by users or shutdown.",
    }),
    rpcRequests: meter.createCounter("orka.rpc.requests", {
      description: "Total number of JSON-RPC requests handled by the daemon.",
    }),
    rpcErrors: meter.createCounter("orka.rpc.errors", {
      description: "Total number of JSON-RPC requests that returned errors.",
    }),
    pushEvents: meter.createCounter("orka.push.events", {
      description: "Total number of push events broadcast to subscribed clients.",
    }),
    rpcDuration: meter.createHistogram("orka.rpc.duration", {
      description: "End-to-end JSON-RPC handler duration.",
      unit: "ms",
    }),
    sessionDuration: meter.createHistogram("orka.session.duration", {
      description: "Session wall-clock duration from startedAt to terminal state.",
      unit: "ms",
    }),
    sessionsActive: meter.createUpDownCounter("orka.sessions.active", {
      description: "Current number of running sessions.",
    }),
    wsConnections: meter.createUpDownCounter("orka.ws.connections", {
      description: "Current number of daemon WebSocket connections.",
    }),
  };

  return _daemonMetrics;
}

export async function queryMetricSnapshot(): Promise<MetricSnapshot | null> {
  return withSpan("orka.metrics.query_snapshot", {}, async () => {
    if (!_meterProvider || !_metricSnapshotExporter) {
      return null;
    }

    await _meterProvider.forceFlush();
    const snapshots = _metricSnapshotExporter.getMetrics();
    const latest = snapshots.at(-1);
    return latest ? serializeResourceMetricsSnapshot(latest) : null;
  });
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
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage });
      if (err instanceof Error) span.recordException(err);
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
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function persistOtlpJsonTraces(payload: unknown, dataDir: string): void {
  appendTraceLogEntries(parseOtlpJsonTraceEntries(payload), dataDir);
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

function serializeMetricsToOtlpJson(resourceMetrics: ResourceMetrics): { resourceMetrics: Array<Record<string, unknown>> } {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: attributesToOtlp(resourceMetrics.resource.attributes),
        },
        scopeMetrics: resourceMetrics.scopeMetrics.map((scopeMetrics) => ({
          scope: {
            name: scopeMetrics.scope.name,
            version: scopeMetrics.scope.version,
          },
          metrics: scopeMetrics.metrics.map(serializeMetricToOtlp),
        })),
      },
    ],
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

function serializeResourceMetricsSnapshot(resourceMetrics: ResourceMetrics): MetricSnapshot {
  return {
    resourceAttributes: attributesToJson(resourceMetrics.resource.attributes),
    scopeMetrics: resourceMetrics.scopeMetrics.map((scopeMetrics) => ({
      scope: {
        name: scopeMetrics.scope.name,
        ...(scopeMetrics.scope.version ? { version: scopeMetrics.scope.version } : {}),
      },
      metrics: scopeMetrics.metrics.map((metric) => ({
        name: metric.descriptor.name,
        description: metric.descriptor.description,
        unit: metric.descriptor.unit,
        dataPointType: dataPointTypeToString(metric.dataPointType),
        aggregationTemporality: aggregationTemporalityToString(metric.aggregationTemporality),
        ...("isMonotonic" in metric ? { isMonotonic: metric.isMonotonic } : {}),
        dataPoints: metric.dataPoints.map((dataPoint) => ({
          startTime: hrTimeToMs(dataPoint.startTime),
          endTime: hrTimeToMs(dataPoint.endTime),
          attributes: attributesToJson(dataPoint.attributes),
          value: serializeMetricPointValue(metric.dataPointType, dataPoint.value),
        })),
      })),
    })),
  };
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

function normalizeOtlpHttpEndpoint(endpoint: string, signal: "traces" | "metrics"): string {
  try {
    const url = new URL(endpoint);
    if (/\/v1\/(?:traces|metrics)$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/v1\/(?:traces|metrics)$/, `/v1/${signal}`);
      return url.toString();
    }

    const trimmedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${trimmedPath}/v1/${signal}`.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return endpoint;
  }
}

function serializeMetricToOtlp(metric: MetricData): Record<string, unknown> {
  const descriptor = {
    name: metric.descriptor.name,
    description: metric.descriptor.description,
    unit: metric.descriptor.unit,
  };

  switch (metric.dataPointType) {
    case DataPointType.GAUGE:
      return {
        ...descriptor,
        gauge: {
          dataPoints: metric.dataPoints.map((dataPoint) => serializeNumberDataPointToOtlp(dataPoint)),
        },
      };
    case DataPointType.SUM:
      return {
        ...descriptor,
        sum: {
          aggregationTemporality: metric.aggregationTemporality,
          isMonotonic: metric.isMonotonic,
          dataPoints: metric.dataPoints.map((dataPoint) => serializeNumberDataPointToOtlp(dataPoint)),
        },
      };
    case DataPointType.HISTOGRAM:
      return {
        ...descriptor,
        histogram: {
          aggregationTemporality: metric.aggregationTemporality,
          dataPoints: metric.dataPoints.map((dataPoint) => serializeHistogramDataPointToOtlp(dataPoint)),
        },
      };
    case DataPointType.EXPONENTIAL_HISTOGRAM:
      return {
        ...descriptor,
        exponentialHistogram: {
          aggregationTemporality: metric.aggregationTemporality,
          dataPoints: metric.dataPoints.map((dataPoint) => serializeExponentialHistogramDataPointToOtlp(dataPoint)),
        },
      };
  }
}

function serializeNumberDataPointToOtlp(
  dataPoint:
    | Extract<MetricData, { dataPointType: DataPointType.GAUGE }>["dataPoints"][number]
    | Extract<MetricData, { dataPointType: DataPointType.SUM }>["dataPoints"][number],
): Record<string, unknown> {
  return {
    attributes: attributesToOtlp(dataPoint.attributes),
    startTimeUnixNano: hrTimeToUnixNanos(dataPoint.startTime),
    timeUnixNano: hrTimeToUnixNanos(dataPoint.endTime),
    asDouble: dataPoint.value,
  };
}

function serializeHistogramDataPointToOtlp(
  dataPoint: Extract<MetricData, { dataPointType: DataPointType.HISTOGRAM }>["dataPoints"][number],
): Record<string, unknown> {
  return {
    attributes: attributesToOtlp(dataPoint.attributes),
    startTimeUnixNano: hrTimeToUnixNanos(dataPoint.startTime),
    timeUnixNano: hrTimeToUnixNanos(dataPoint.endTime),
    count: String(dataPoint.value.count),
    ...(dataPoint.value.sum !== undefined ? { sum: dataPoint.value.sum } : {}),
    bucketCounts: dataPoint.value.buckets.counts.map((count) => String(count)),
    explicitBounds: dataPoint.value.buckets.boundaries,
    ...(dataPoint.value.min !== undefined ? { min: dataPoint.value.min } : {}),
    ...(dataPoint.value.max !== undefined ? { max: dataPoint.value.max } : {}),
  };
}

function serializeExponentialHistogramDataPointToOtlp(
  dataPoint: Extract<MetricData, { dataPointType: DataPointType.EXPONENTIAL_HISTOGRAM }>["dataPoints"][number],
): Record<string, unknown> {
  return {
    attributes: attributesToOtlp(dataPoint.attributes),
    startTimeUnixNano: hrTimeToUnixNanos(dataPoint.startTime),
    timeUnixNano: hrTimeToUnixNanos(dataPoint.endTime),
    count: String(dataPoint.value.count),
    ...(dataPoint.value.sum !== undefined ? { sum: dataPoint.value.sum } : {}),
    scale: dataPoint.value.scale,
    zeroCount: String(dataPoint.value.zeroCount),
    positive: {
      offset: dataPoint.value.positive.offset,
      bucketCounts: dataPoint.value.positive.bucketCounts.map((count) => String(count)),
    },
    negative: {
      offset: dataPoint.value.negative.offset,
      bucketCounts: dataPoint.value.negative.bucketCounts.map((count) => String(count)),
    },
    ...(dataPoint.value.min !== undefined ? { min: dataPoint.value.min } : {}),
    ...(dataPoint.value.max !== undefined ? { max: dataPoint.value.max } : {}),
  };
}

function dataPointTypeToString(dataPointType: DataPointType): string {
  switch (dataPointType) {
    case DataPointType.GAUGE:
      return "GAUGE";
    case DataPointType.HISTOGRAM:
      return "HISTOGRAM";
    case DataPointType.EXPONENTIAL_HISTOGRAM:
      return "EXPONENTIAL_HISTOGRAM";
    case DataPointType.SUM:
      return "SUM";
  }
}

function aggregationTemporalityToString(temporality: AggregationTemporality): string {
  switch (temporality) {
    case AggregationTemporality.DELTA:
      return "DELTA";
    case AggregationTemporality.CUMULATIVE:
      return "CUMULATIVE";
  }
}

function serializeMetricPointValue(dataPointType: DataPointType, value: unknown): unknown {
  if (dataPointType === DataPointType.SUM || dataPointType === DataPointType.GAUGE) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
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
