import type { ErrorInfo, PropsWithChildren, ReactNode } from "react";
import { Component } from "react";
import { SpanStatusCode } from "@opentelemetry/api";
import { AlertTriangle, RefreshCcw, RotateCw } from "lucide-react";
import { getTracer } from "../lib/tracing";

const AUTO_DISMISS_MS = 10_000;
const IS_DEV = import.meta.env.DEV;

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
  return {
    error: error.message || error.name,
    stack: details ?? error.stack,
    url: window.location.href,
    timestamp: new Date().toISOString(),
  };
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
  state: ErrorBoundaryState = {
    banner: null,
    error: null,
    errorDetails: null,
  };

  private bannerTimeout: ReturnType<typeof setTimeout> | null = null;
  private nextBannerId = 0;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      error,
      errorDetails: error.stack ?? null,
    };
  }

  componentDidMount(): void {
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  componentWillUnmount(): void {
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
    this.clearBannerTimeout();
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const errorDetails = getErrorDetails(error, errorInfo.componentStack);
    this.setState({ errorDetails });
    recordErrorSpan(error, "react.error_boundary", errorDetails);
    this.reportError(createReport(error, errorDetails));
  }

  render(): ReactNode {
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
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-zinc-100">
        <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900/95 p-8 shadow-2xl shadow-black/30">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-500">Application Error</p>
              <h1 className="mt-2 text-2xl font-semibold text-zinc-50">Something went wrong</h1>
              <p className="mt-3 break-words text-sm leading-6 text-zinc-300">
                {error.message || "The dashboard hit an unexpected error."}
              </p>
            </div>
          </div>
          {IS_DEV && errorDetails ? (
            <details className="mt-6 rounded-xl border border-zinc-800 bg-slate-950/80">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-300">
                Stack trace
              </summary>
              <pre className="overflow-x-auto border-t border-zinc-800 px-4 py-4 text-xs leading-5 text-zinc-400">
                {errorDetails}
              </pre>
            </details>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-white"
            >
              <RotateCw className="h-4 w-4" />
              Retry
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-zinc-600 hover:bg-zinc-800"
            >
              <RefreshCcw className="h-4 w-4" />
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
        <div className="pointer-events-auto flex w-full max-w-2xl items-start gap-3 rounded-xl border border-amber-500/30 bg-zinc-900/95 px-4 py-3 text-sm text-zinc-100 shadow-lg shadow-black/25 backdrop-blur">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-zinc-50">Unhandled promise rejection</p>
            <p className="mt-1 break-words text-zinc-300">{banner.message}</p>
          </div>
          <button
            type="button"
            onClick={this.dismissBanner}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
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
