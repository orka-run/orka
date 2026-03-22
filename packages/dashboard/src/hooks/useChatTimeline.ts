import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestrationEvent } from "@orka/core";
import { useTransport, useRpcClient } from "../lib/transportContext";
import { useTimelineCache } from "../lib/timelineCache";
import { eventsToEntries, type ChatEntry } from "../components/chat/eventsToEntries";

/** Minimum interval between eventsToEntries rebuilds (ms). */
const REBUILD_DEBOUNCE_MS = 80;

interface UseChatTimelineOptions {
  sessionId: string;
  initialPrompt?: string;
  projectPath?: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
}

export function useChatTimeline({
  sessionId,
  initialPrompt,
  projectPath,
  onSelectionLoadSettled,
}: UseChatTimelineOptions) {
  const transport = useTransport();
  const client = useRpcClient();
  const getCachedTimeline = useTimelineCache((state) => state.get);
  const setCachedTimeline = useTimelineCache((state) => state.set);
  const hydrateTimeline = useTimelineCache((state) => state.hydrate);

  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /** True when cache is rendered but delta fetch is still in flight. */
  const [isFetchingDelta, setIsFetchingDelta] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventsRef = useRef<OrchestrationEvent[]>([]);
  const initialPromptRef = useRef(initialPrompt);
  initialPromptRef.current = initialPrompt;
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const onSelectionLoadSettledRef = useRef(onSelectionLoadSettled);
  onSelectionLoadSettledRef.current = onSelectionLoadSettled;

  const seenIdsRef = useRef(new Set<string>());
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rebuildRafRef = useRef<number | null>(null);

  /** Rebuild entries from current events (runs in rAF to avoid blocking input). */
  const rebuildEntries = useCallback(() => {
    const evts = eventsRef.current;
    // Use rAF so the browser can process pending input/paint first
    if (rebuildRafRef.current !== null) cancelAnimationFrame(rebuildRafRef.current);
    rebuildRafRef.current = requestAnimationFrame(() => {
      rebuildRafRef.current = null;
      setEntries(eventsToEntries(evts, initialPromptRef.current, projectPathRef.current));
    });
  }, []);

  /** Apply a complete event list to all state (events, entries, seenIds). */
  const applyEvents = useCallback((evts: OrchestrationEvent[]) => {
    eventsRef.current = evts;
    seenIdsRef.current = new Set<string>();
    for (const e of evts) if (e.eventId) seenIdsRef.current.add(e.eventId);
    setEvents(evts);
    rebuildEntries();
  }, [rebuildEntries]);

  /** Schedule a debounced rebuild — used for high-frequency WS events. */
  const scheduleRebuild = useCallback(() => {
    if (rebuildTimerRef.current !== null) return; // already scheduled
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      setEvents(eventsRef.current);
      rebuildEntries();
    }, REBUILD_DEBOUNCE_MS);
  }, [rebuildEntries]);

  // ---------------------------------------------------------------------------
  // Effect 1: Initial load — memory → IDB hydration → delta/full server fetch
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    eventsRef.current = [];
    seenIdsRef.current = new Set();

    // Step 1: Try in-memory cache for instant render
    const memCached = getCachedTimeline(sessionId);
    if (memCached) {
      const filtered = memCached.filter((event) => event.sessionId === sessionId);
      applyEvents(filtered);
      setIsLoading(false);
      onSelectionLoadSettledRef.current?.("ok");
    } else {
      setIsLoading(true);
      setError(null);
      setEvents([]);
      setEntries([]);
    }

    async function load() {
      try {
        // Step 2: If not in memory, try IDB hydration
        let cachedEvents = memCached;
        if (!cachedEvents) {
          const hydrated = await hydrateTimeline(sessionId);
          if (cancelled) return;
          if (hydrated) {
            cachedEvents = hydrated.filter((e) => e.sessionId === sessionId);
            applyEvents(cachedEvents);
            setIsLoading(false);
          }
        }

        // Step 3: Delta fetch (offset = cached count) or full fetch
        const cachedCount = cachedEvents?.length ?? 0;
        if (cachedCount > 0) setIsFetchingDelta(true);
        const response = await client.getSessionTimeline({
          sessionId,
          ...(cachedCount > 0 ? { offset: cachedCount } : {}),
        });
        if (cancelled) return;

        if (cachedCount > 0 && response.total < cachedCount) {
          // Cache stale (events deleted server-side, e.g. session retry) — full refetch
          const full = await client.getSessionTimeline({ sessionId });
          if (cancelled) return;
          const merged = mergeServerWithWs(full.events, sessionId, eventsRef.current);
          applyEvents(merged);
          setCachedTimeline(sessionId, merged);
        } else if (cachedCount > 0 && response.events.length > 0) {
          // Delta — append new server events
          const merged = appendDelta(response.events, sessionId, eventsRef.current, seenIdsRef.current);
          applyEvents(merged);
          setCachedTimeline(sessionId, merged);
        } else if (cachedCount === 0) {
          // Full fetch (no prior cache)
          const merged = mergeServerWithWs(response.events, sessionId, eventsRef.current);
          applyEvents(merged);
          setCachedTimeline(sessionId, response.events);
        }
        // else: cachedCount > 0 && no new events — cache is current

        onSelectionLoadSettledRef.current?.("ok");
      } catch (cause) {
        if (cancelled) return;
        if (eventsRef.current.length === 0) {
          setError(cause instanceof Error ? cause.message : "Failed to load chat timeline");
          onSelectionLoadSettledRef.current?.("error", cause);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsFetchingDelta(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyEvents, client, getCachedTimeline, hydrateTimeline, sessionId, setCachedTimeline]);

  // ---------------------------------------------------------------------------
  // Effect 2: Live WS events — accumulate and debounce rebuild
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return transport.subscribe("orchestration.event", (data) => {
      const event = data as OrchestrationEvent;
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.eventId && seenIdsRef.current.has(event.eventId)) {
        return;
      }
      if (event.eventId) seenIdsRef.current.add(event.eventId);

      eventsRef.current = [...eventsRef.current, event];
      scheduleRebuild();
    });
  }, [scheduleRebuild, sessionId, transport]);

  // ---------------------------------------------------------------------------
  // Effect 3: Delta fetch on WS reconnect
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let wasDisconnected = false;

    const unsub = transport.onStateChange((snapshot) => {
      if (snapshot.state === "connected" && wasDisconnected) {
        void deltaFetchOnReconnect();
      }
      wasDisconnected = snapshot.state === "reconnecting" || snapshot.state === "disconnected";
    });

    async function deltaFetchOnReconnect() {
      const current = eventsRef.current;
      const offset = current.length;
      try {
        const response = await client.getSessionTimeline({
          sessionId,
          ...(offset > 0 ? { offset } : {}),
        });

        if (offset > 0 && response.total < offset) {
          // Stale — full refetch
          const full = await client.getSessionTimeline({ sessionId });
          const merged = mergeServerWithWs(full.events, sessionId, eventsRef.current);
          applyEvents(merged);
          setCachedTimeline(sessionId, merged);
        } else if (offset > 0 && response.events.length > 0) {
          // Delta merge
          const merged = appendDelta(response.events, sessionId, eventsRef.current, seenIdsRef.current);
          applyEvents(merged);
          setCachedTimeline(sessionId, merged);
        } else if (offset === 0) {
          // No prior events — full fetch
          const merged = mergeServerWithWs(response.events, sessionId, eventsRef.current);
          applyEvents(merged);
          setCachedTimeline(sessionId, response.events);
        }
      } catch {
        // Silent failure on reconnect — live WS events will fill gaps
      }
    }

    return unsub;
  }, [applyEvents, client, sessionId, setCachedTimeline, transport]);

  // ---------------------------------------------------------------------------
  // Effect 4: Persist + cleanup timers on session change / unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const sid = sessionId;
    return () => {
      // Cancel pending debounce/rAF
      if (rebuildTimerRef.current !== null) {
        clearTimeout(rebuildTimerRef.current);
        rebuildTimerRef.current = null;
      }
      if (rebuildRafRef.current !== null) {
        cancelAnimationFrame(rebuildRafRef.current);
        rebuildRafRef.current = null;
      }
      // Persist accumulated events
      const current = eventsRef.current;
      if (current.length > 0 && current[0]?.sessionId === sid) {
        setCachedTimeline(sid, current);
      }
    };
  }, [sessionId, setCachedTimeline]);

  // ---------------------------------------------------------------------------
  // Approval handling (unchanged)
  // ---------------------------------------------------------------------------
  const handleApprovalResolve = useCallback(async (requestId: string, decision: "approve" | "deny") => {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.type === "approval" && entry.requestId === requestId
          ? { ...entry, status: decision === "approve" ? "approved" as const : "denied" as const }
          : entry,
      ),
    );

    try {
      await client.resolveApproval(requestId, decision);
    } catch (error) {
      setEntries((prev) =>
        prev.map((entry) =>
          entry.type === "approval" && entry.requestId === requestId
            ? { ...entry, status: "pending" as const }
            : entry,
        ),
      );
      throw error;
    }
  }, [client]);

  return {
    events,
    entries,
    setEntries,
    isLoading,
    isFetchingDelta,
    error,
    handleApprovalResolve,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Merge server events with any WS events that arrived during the fetch. */
function mergeServerWithWs(
  serverEvents: OrchestrationEvent[],
  sessionId: string,
  currentEvents: OrchestrationEvent[],
): OrchestrationEvent[] {
  const filtered = serverEvents.filter((e) => e.sessionId === sessionId);
  const fetchedIds = new Set<string>();
  for (const e of filtered) if (e.eventId) fetchedIds.add(e.eventId);
  const wsOnly = currentEvents.filter((e) => e.eventId && !fetchedIds.has(e.eventId));
  return [...filtered, ...wsOnly];
}

/** Append new events from a delta fetch, deduplicating by eventId. */
function appendDelta(
  newServerEvents: OrchestrationEvent[],
  sessionId: string,
  currentEvents: OrchestrationEvent[],
  seenIds: Set<string>,
): OrchestrationEvent[] {
  const filtered = newServerEvents.filter((e) => e.sessionId === sessionId);
  const fresh = filtered.filter((e) => !e.eventId || !seenIds.has(e.eventId));
  if (fresh.length === 0) return currentEvents;
  return [...currentEvents, ...fresh];
}
