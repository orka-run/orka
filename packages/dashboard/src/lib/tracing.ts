import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "orka-dashboard";
const TRACE_EXPORT_URL = "/v1/traces";

let provider: WebTracerProvider | null = null;

function getNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function initDashboardTracing(): void {
  if (provider) {
    return;
  }

  provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "orka-dashboard",
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: TRACE_EXPORT_URL,
        }),
      ),
    ],
  });

  provider.register();
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function injectSpanContext(span: Span, carrier: Record<string, string | undefined>): void {
  propagation.inject(trace.setSpan(context.active(), span), carrier);
}

export function startDashboardSpan(
  name: string,
  attributes?: Attributes,
  parentContext: Context = context.active(),
): { span: Span; startedAt: number } {
  return {
    span: getTracer().startSpan(name, attributes ? { attributes } : {}, parentContext),
    startedAt: getNow(),
  };
}

export function finishDashboardSpan(
  span: Span,
  startedAt: number,
  status: string,
  error?: unknown,
): void {
  span.setAttribute("orka.status", status);
  span.setAttribute("orka.duration_ms", Math.max(0, getNow() - startedAt));

  if (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error) {
      span.recordException(error);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}

export async function withDashboardSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    const startedAt = getNow();

    try {
      const result = await fn(span);
      finishDashboardSpan(span, startedAt, "ok");
      return result;
    } catch (error) {
      finishDashboardSpan(span, startedAt, "error", error);
      throw error;
    }
  });
}
