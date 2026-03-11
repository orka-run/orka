import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, ArrowDown } from "lucide-react";
import type { SessionLogLineData } from "@orka/core";
import type { WsTransport } from "../lib/wsTransport";
import { parseAnsi } from "../lib/ansiParser";
import { useSessionStore } from "../stores/sessionStore";

interface LogPanelProps {
  sessionId: string;
  transport: WsTransport;
}

export function LogPanel({ sessionId, transport }: LogPanelProps) {
  const session = useSessionStore((state) => state.sessions.find((s) => s.id === sessionId) ?? null);
  const [logContent, setLogContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const isRunning = session?.status === "running" || session?.status === "preparing" || session?.status === "queued";

  // Fetch initial log content
  useEffect(() => {
    let cancelled = false;

    async function fetchLogs() {
      setIsLoading(true);
      setError(null);

      try {
        const content = await transport.request<string | null>("getLogContent", { sessionId });
        if (cancelled) return;

        const text = content ?? "";
        setLogContent(text);
        offsetRef.current = new TextEncoder().encode(text).byteLength;
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to fetch logs");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void fetchLogs();

    return () => {
      cancelled = true;
    };
  }, [sessionId, transport]);

  // Subscribe to real-time log updates
  useEffect(() => {
    const unsubscribe = transport.subscribe("session.logLine", (data) => {
      const logLine = data as SessionLogLineData;
      if (logLine.sessionId !== sessionId) return;

      const expectedOffset = offsetRef.current;

      if (logLine.offset === expectedOffset) {
        // Contiguous — append directly
        setLogContent((prev) => prev + logLine.content);
        offsetRef.current = expectedOffset + new TextEncoder().encode(logLine.content).byteLength;
      } else if (logLine.offset > expectedOffset) {
        // Gap — refetch full content
        void transport.request<string | null>("getLogContent", { sessionId }).then((content) => {
          const text = content ?? "";
          setLogContent(text);
          offsetRef.current = new TextEncoder().encode(text).byteLength;
        });
      }
      // If logLine.offset < expectedOffset, we already have this data — skip
    });

    return unsubscribe;
  }, [sessionId, transport]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [logContent, autoScroll]);

  // Detect manual scroll up to pause auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  const parsedSpans = useMemo(() => parseAnsi(logContent), [logContent]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/50">
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading logs…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-950 bg-red-950/20 p-4 text-sm text-red-200">
        <p className="font-medium">Unable to load session logs.</p>
        <p className="mt-1 text-red-200/80">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/70">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Session Logs</p>
          {isRunning ? (
            <p className="mt-1 text-sm text-zinc-400">Streaming live output…</p>
          ) : (
            <p className="mt-1 text-sm text-zinc-400">
              {logContent ? `${logContent.split("\n").length} lines` : "No log output"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-950/60 px-2.5 py-1 text-xs text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Live
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto bg-zinc-950 p-4"
        >
          <pre className="font-mono text-xs leading-5 text-zinc-300">
            {parsedSpans.length > 0 ? (
              parsedSpans.map((span, i) => (
                <span key={i} style={span.style}>{span.text}</span>
              ))
            ) : (
              <span className="text-zinc-500">No log output yet.</span>
            )}
          </pre>
          <div ref={bottomRef} />
        </div>

        {!autoScroll ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-6 flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur transition hover:bg-zinc-700"
          >
            <ArrowDown className="h-3 w-3" />
            Scroll to bottom
          </button>
        ) : null}
      </div>
    </div>
  );
}
