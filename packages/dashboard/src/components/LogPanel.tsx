import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, ArrowDown } from "lucide-react";
import type { SessionLogLineData } from "@orka/core";
import type { WsTransport } from "../lib/wsTransport";
import { parseAnsiIncremental, createAnsiContext } from "../lib/ansiParser";
import type { AnsiSpan } from "../lib/ansiParser";
import { useSessionStore } from "../stores/sessionStore";

const encoder = new TextEncoder();

interface LogPanelProps {
  sessionId: string;
  transport: WsTransport;
  onInitialLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
}

export function LogPanel({ sessionId, transport, onInitialLoadSettled }: LogPanelProps) {
  const session = useSessionStore((state) => state.sessions.find((s) => s.id === sessionId) ?? null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [renderTick, setRenderTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const lineCountRef = useRef(0);
  const isRunning = session?.status === "running" || session?.status === "preparing" || session?.status === "queued";

  // Incremental ANSI parsing state
  const ansiCtxRef = useRef(createAnsiContext());
  const spansRef = useRef<AnsiSpan[]>([]);

  // rAF batching
  const pendingRef = useRef("");
  const rafRef = useRef(0);

  const flushPending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = "";
    rafRef.current = 0;
    if (!pending) return;

    for (let i = 0; i < pending.length; i++) {
      if (pending[i] === "\n") lineCountRef.current++;
    }

    const newSpans = parseAnsiIncremental(pending, ansiCtxRef.current);
    if (newSpans.length > 0) {
      for (const span of newSpans) {
        spansRef.current.push(span);
      }
      setRenderTick((t) => t + 1);
    }
  }, []);

  const appendDelta = useCallback(
    (delta: string) => {
      offsetRef.current += encoder.encode(delta).byteLength;
      pendingRef.current += delta;
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(flushPending);
      }
    },
    [flushPending],
  );

  const resetContent = useCallback((text: string) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    pendingRef.current = "";

    offsetRef.current = encoder.encode(text).byteLength;
    lineCountRef.current = text ? text.split("\n").length : 0;

    ansiCtxRef.current = createAnsiContext();
    spansRef.current = parseAnsiIncremental(text, ansiCtxRef.current);
    setRenderTick((t) => t + 1);
  }, []);

  // Fetch initial log content
  useEffect(() => {
    let cancelled = false;

    async function fetchLogs() {
      setIsLoading(true);
      setError(null);

      try {
        const content = await transport.request<string | null>("getLogContent", { sessionId });
        if (cancelled) return;

        resetContent(content ?? "");
        onInitialLoadSettled?.("ok");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to fetch logs");
        onInitialLoadSettled?.("error", e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void fetchLogs();

    return () => {
      cancelled = true;
    };
  }, [onInitialLoadSettled, sessionId, transport, resetContent]);

  // Subscribe to real-time log updates
  useEffect(() => {
    const unsubscribe = transport.subscribe("session.logLine", (data) => {
      const logLine = data as SessionLogLineData;
      if (logLine.sessionId !== sessionId) return;

      const directLine = logLine.line ?? (logLine.offset === undefined ? logLine.content : undefined);
      if (directLine !== undefined) {
        appendDelta(directLine);
        return;
      }

      if (logLine.offset === undefined || logLine.content === undefined) {
        return;
      }

      const content = logLine.content;
      const expectedOffset = offsetRef.current;

      if (logLine.offset === expectedOffset) {
        appendDelta(content);
      } else if (logLine.offset > expectedOffset) {
        void transport.request<string | null>("getLogContent", { sessionId }).then((fullContent) => {
          resetContent(fullContent ?? "");
        });
      }
    });

    return unsubscribe;
  }, [sessionId, transport, appendDelta, resetContent]);

  // Auto-scroll after batched render
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [renderTick, autoScroll]);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Detect manual scroll up to pause auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const spans = spansRef.current;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-sm border border-border bg-surface">
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading logs…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-sm border border-status-error/30 bg-status-error/10 p-2 text-[12px] text-status-error">
        <p className="font-medium">Unable to load session logs.</p>
        <p className="mt-1 opacity-80">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-sm border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Session Logs</p>
          {isRunning ? (
            <p className="mt-0.5 text-[11px] text-ink-muted">Streaming live output…</p>
          ) : (
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {spans.length > 0 ? `${String(lineCountRef.current)} lines` : "No log output"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isRunning ? (
            <span className="flex items-center gap-1 rounded-sm bg-emerald-600/10 px-1.5 py-0.5 text-[10px] text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-sm bg-emerald-600" />
              Live
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto bg-surface p-2"
        >
          <pre className="overflow-x-auto font-mono text-[11px] leading-5 text-ink-secondary [-webkit-overflow-scrolling:touch]">
            {spans.length > 0 ? (
              spans.map((span, i) => (
                <span key={i} style={span.style}>
                  {span.text}
                </span>
              ))
            ) : (
              <span className="text-ink-muted">No log output yet.</span>
            )}
          </pre>
        </div>

        {!autoScroll ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-2 right-4 flex items-center gap-1 rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink-secondary backdrop-blur transition hover:bg-surface-hover"
          >
            <ArrowDown className="h-3 w-3" />
            Scroll to bottom
          </button>
        ) : null}
      </div>
    </div>
  );
}
