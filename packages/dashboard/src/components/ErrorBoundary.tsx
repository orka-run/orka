import type { ErrorInfo, PropsWithChildren, ReactNode } from "react";
import { Component } from "react";
import { SpanStatusCode } from "@opentelemetry/api";
import { AlertTriangle, RefreshCcw, RotateCw } from "lucide-react";
import { getTracer } from "../lib/tracing";

const AUTO_DISMISS_MS = 10_000;
const IS_DEV = !!import.meta.env["DEV"];

export interface ClientErrorReport {
  error: string;
  stack?: string;
  url: string;
  timestamp: string;
}

interface ErrorBoundaryProps extends PropsWithChildren {
  reportError?: (report: ClientErrorReport) => Promise<void> | void;
}

interface ErrorBannerState {
  id: number;
  message: string;
}

interface ErrorBoundaryState {
  banner: ErrorBannerState | null;
  error: Error | null;
  errorDetails: string | null;
}

function getErrorDetails(error: Error, componentStack?: string): string | null {
  const parts = [error.stack?.trim(), componentStack?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    const serialized = JSON.stringify(error);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall through to String coercion below.
  }

  return String(error);
}

function getErrorObject(error: unknown): Error {
  return error instanceof Error ? error : new Error(getErrorMessage(error));
}

function createReport(error: Error, details?: string | null): ClientErrorReport {
  const stack = details ?? error.stack;
  const report: ClientErrorReport = {
    error: error.message || error.name,
    url: window.location.href,
    timestamp: new Date().toISOString(),
  };
  if (stack) report.stack = stack;
  return report;
}

function recordErrorSpan(error: Error, source: string, details?: string | null): void {
  try {
    const span = getTracer().startSpan("orka.dashboard.client_error", {
      attributes: {
        "orka.error.source": source,
        "orka.error.message": error.message || error.name,
        "orka.error.url": window.location.href,
        ...(details ? { "orka.error.details": details } : {}),
      },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error);
    span.end();
  } catch {
    // Best-effort — tracing failure must never break the error boundary.
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    banner: null,
    error: null,
    errorDetails: null,
  };

  private bannerTimeout: number | null = null;
  private nextBannerId = 0;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      error,
      errorDetails: error.stack ?? null,
    };
  }

  override componentDidMount(): void {
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
    window.addEventListener("error", this.handleGlobalError);
  }

  override componentWillUnmount(): void {
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
    window.removeEventListener("error", this.handleGlobalError);
    this.clearBannerTimeout();
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const errorDetails = getErrorDetails(error, errorInfo.componentStack ?? undefined);
    this.setState({ errorDetails });
    recordErrorSpan(error, "react.error_boundary", errorDetails);
    this.reportError(createReport(error, errorDetails));
  }

  override render(): ReactNode {
    const { banner, error, errorDetails } = this.state;

    return (
      <>
        {error ? this.renderErrorFallback(error, errorDetails) : this.props.children}
        {banner ? this.renderBanner(banner) : null}
      </>
    );
  }

  private renderErrorFallback(error: Error, errorDetails: string | null): ReactNode {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-8 text-ink">
        <div className="w-full max-w-2xl rounded-sm border border-border bg-surface p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-status-warning/30 bg-status-warning/10 p-2 text-status-warning">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-muted">Application Error</p>
              <h1 className="mt-1 text-[16px] font-semibold text-ink">Something went wrong</h1>
              <p className="mt-2 break-words text-[12px] leading-6 text-ink-secondary">
                {error.message || "The dashboard hit an unexpected error."}
              </p>
            </div>
          </div>
          {IS_DEV && errorDetails ? (
            <details className="mt-4 rounded-sm border border-border bg-surface-alt">
              <summary className="cursor-pointer list-none px-2 py-1.5 text-[12px] font-medium text-ink-secondary">
                Stack trace
              </summary>
              <pre className="overflow-x-auto border-t border-border px-2 py-2 text-[11px] leading-5 text-ink-muted">
                {errorDetails}
              </pre>
            </details>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
            >
              <RotateCw className="h-3.5 w-3.5" />
              Retry
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition hover:text-ink"
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }

  private renderBanner(banner: ErrorBannerState): ReactNode {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
        <div className="pointer-events-auto flex w-full max-w-2xl items-start gap-2 rounded-sm border border-status-warning/30 bg-surface px-3 py-2 text-[12px] text-ink backdrop-blur">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">Unhandled promise rejection</p>
            <p className="mt-0.5 break-words text-ink-secondary">{banner.message}</p>
          </div>
          <button
            type="button"
            onClick={this.dismissBanner}
            className="rounded-sm px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:bg-surface-hover hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  private handleRetry = (): void => {
    this.setState({
      error: null,
      errorDetails: null,
    });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    event.preventDefault();
    const error = getErrorObject(event.reason);
    const message = getErrorMessage(event.reason) || "An async action failed unexpectedly.";
    recordErrorSpan(error, "unhandled_rejection");

    this.setState({
      banner: {
        id: ++this.nextBannerId,
        message,
      },
    });

    this.clearBannerTimeout();
    this.bannerTimeout = window.setTimeout(() => {
      this.setState((state) => {
        if (!state.banner || state.banner.id !== this.nextBannerId) {
          return null;
        }

        return { banner: null };
      });
    }, AUTO_DISMISS_MS);

    this.reportError(createReport(error));
  };

  private handleGlobalError = (event: ErrorEvent): void => {
    const error = event.error instanceof Error ? event.error : new Error(event.message || "Unknown error");
    const details = [
      event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : null,
      error.stack,
    ].filter(Boolean).join("\n");
    recordErrorSpan(error, "window.onerror", details || undefined);
    this.reportError(createReport(error, details || undefined));
  };

  private dismissBanner = (): void => {
    this.clearBannerTimeout();
    this.setState({ banner: null });
  };

  private clearBannerTimeout(): void {
    if (this.bannerTimeout !== null) {
      clearTimeout(this.bannerTimeout);
      this.bannerTimeout = null;
    }
  }

  private reportError(report: ClientErrorReport): void {
    try {
      void Promise.resolve(this.props.reportError?.(report)).catch(() => undefined);
    } catch {
      // Best-effort reporting only.
    }
  }
}
