import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const TRACER_NAME = "orka-client";

function getNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function startSpan(
  name: string,
  attributes?: Attributes,
): { span: Span; startedAt: number } {
  return {
    span: trace.getTracer(TRACER_NAME).startSpan(name, attributes ? { attributes } : {}),
    startedAt: getNow(),
  };
}

export function finishSpan(
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

export function injectSpanContext(
  span: Span,
  carrier: Record<string, string | undefined>,
): void {
  propagation.inject(trace.setSpan(context.active(), span), carrier);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) span.recordException(err);
      span.end();
      throw err;
    }
  });
}
