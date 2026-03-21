import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestrationEvent } from "@orka/core";
import { useTransport, useRpcClient } from "../lib/transportContext";
import { useTimelineCache } from "../lib/timelineCache";
import { eventsToEntries, type ChatEntry } from "../components/chat/eventsToEntries";

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

  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const eventsRef = useRef<OrchestrationEvent[]>([]);
  const initialPromptRef = useRef(initialPrompt);
  initialPromptRef.current = initialPrompt;
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const onSelectionLoadSettledRef = useRef(onSelectionLoadSettled);
  onSelectionLoadSettledRef.current = onSelectionLoadSettled;

  const seenIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    eventsRef.current = [];
    seenIdsRef.current = new Set();

    const cached = getCachedTimeline(sessionId);
    if (cached) {
      const filtered = cached.filter((event) => event.sessionId === sessionId);
      eventsRef.current = filtered;
      for (const e of filtered) if (e.eventId) seenIdsRef.current.add(e.eventId);
      setEvents(filtered);
      setEntries(eventsToEntries(filtered, initialPromptRef.current, projectPathRef.current));
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
        const response = await client.getSessionTimeline({ sessionId });
        if (cancelled) {
          return;
        }

        const timeline = response.events;
        const filtered = timeline.filter((event: OrchestrationEvent) => event.sessionId === sessionId);

        // Merge: fetched events + any WS events that arrived during fetch
        const fetchedIds = new Set<string>();
        for (const e of filtered) if (e.eventId) fetchedIds.add(e.eventId);
        const wsOnly = eventsRef.current.filter((e) => e.eventId && !fetchedIds.has(e.eventId));
        const merged = [...filtered, ...wsOnly];

        seenIdsRef.current = new Set<string>();
        for (const e of merged) if (e.eventId) seenIdsRef.current.add(e.eventId);

        eventsRef.current = merged;
        setEvents(merged);
        setEntries(eventsToEntries(merged, initialPromptRef.current, projectPathRef.current));
        setCachedTimeline(sessionId, timeline);
        onSelectionLoadSettledRef.current?.("ok");
      } catch (cause) {
        if (cancelled) {
          return;
        }
        if (!cached) {
          setError(cause instanceof Error ? cause.message : "Failed to load chat timeline");
          onSelectionLoadSettledRef.current?.("error", cause);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [client, getCachedTimeline, sessionId, setCachedTimeline]);

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
      setEvents(eventsRef.current);
      setEntries(eventsToEntries(eventsRef.current, initialPromptRef.current, projectPathRef.current));
    });
  }, [sessionId, transport]);

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
    error,
    handleApprovalResolve,
  };
}
