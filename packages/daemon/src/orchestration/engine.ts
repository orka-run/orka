import type {
  OrchestrationEvent,
  PersistedOrchestrationEvent,
  ProviderRuntimeEvent,
  RuntimeSessionState,
  SessionProjection,
  SessionStatus,
} from "@orka/core";
import { isKnownRuntimeSessionState } from "@orka/core";
import type { PushHub } from "../push-hub";
import { withSpanSync } from "../tracing";
import { mapProviderEvent } from "./ingestion";

const UNKNOWN_TURN_PREFIX = "unknown-turn:";
export type { SessionProjection } from "@orka/core";

export interface OrchestrationEngineOptions {
  pushHub?: PushHub;
  persistEvent?: (event: PersistedOrchestrationEvent) => void;
  getSessionTimeline?: (sessionId: string) => OrchestrationEvent[];
}

export class OrchestrationEngine {
  private log: OrchestrationEvent[] = [];
  private listeners: Array<(event: OrchestrationEvent) => void> = [];
  private readonly options: OrchestrationEngineOptions;
  private sessionStatusCache = new Map<string, SessionStatus>();

  constructor(pushHub?: PushHub);
  constructor(options?: OrchestrationEngineOptions);
  constructor(pushHubOrOptions?: PushHub | OrchestrationEngineOptions) {
    this.options = pushHubOrOptions instanceof Object && "broadcast" in pushHubOrOptions
      ? { pushHub: pushHubOrOptions as PushHub }
      : (pushHubOrOptions ?? {});
  }

  ingest(sessionId: string, event: ProviderRuntimeEvent): void {
    withSpanSync(
      "orka.orchestration.ingest",
      { "orka.session.id": sessionId, "orka.provider.event_type": event.type },
      () => {
        const orchestrationEvent = mapProviderEvent(sessionId, event);

        const versionedEvent: OrchestrationEvent = {
          ...orchestrationEvent,
          v: orchestrationEvent.v ?? 1,
        };

        this.options.persistEvent?.({
          ...versionedEvent,
          provider: event.provider,
          eventId: event.eventId,
        });
        this.log.push(versionedEvent);

        for (const listener of this.listeners) {
          listener(versionedEvent);
        }

        const derivedState = event.type === "session.exited" || this.options.pushHub
          ? this.projectSessionState(sessionId)
          : null;

        if (event.type === "session.exited" && derivedState) {
          emitLifecycleTimingSpan(sessionId, derivedState);
          // Evict completed session events from in-memory log — they're already persisted to SQLite.
          // Only evict when both persist and retrieval callbacks are available.
          if (this.options.persistEvent && this.options.getSessionTimeline) {
            this.evictSession(sessionId);
          }
        }

        this.options.pushHub?.broadcast("orchestration.event", versionedEvent);

        // Only broadcast sessionUpdated when the derived status actually changes.
        // Previously this fired on every event, causing the dashboard to re-render
        // the full session list on every content.delta — killing scroll position.
        if (derivedState) {
          const derivedStatus = derivedState.projection.status;
          const prevStatus = this.sessionStatusCache.get(sessionId);
          if (derivedStatus !== prevStatus) {
            this.sessionStatusCache.set(sessionId, derivedStatus);
            this.options.pushHub?.broadcast("orchestration.sessionUpdated", {
              sessionId,
              status: derivedStatus,
            });
          }
        }
      },
    );
  }

  /** Emit an OrchestrationEvent directly (not from a ProviderRuntimeEvent).
   *  Persists, pushes to listeners and PushHub. Used for synthetic events like
   *  user.input on session continue. */
  emitDirect(event: OrchestrationEvent): void {
    const versionedEvent: OrchestrationEvent = { ...event, v: event.v ?? 1 };

    this.options.persistEvent?.({
      ...versionedEvent,
      provider: "orka",
      eventId: `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    this.log.push(versionedEvent);

    for (const listener of this.listeners) {
      listener(versionedEvent);
    }

    this.options.pushHub?.broadcast("orchestration.event", versionedEvent);
  }

  onEvent(listener: (event: OrchestrationEvent) => void): () => void {
    return withSpanSync("orka.orchestration.on_event", {}, () => {
      this.listeners.push(listener);
      return () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      };
    });
  }

  getSessionEvents(sessionId: string): OrchestrationEvent[] {
    return withSpanSync("orka.orchestration.get_session_events", { "orka.session.id": sessionId }, () => {
      const inMemory = this.log.filter((event) => event.sessionId === sessionId);
      // If evicted from memory, fall through to persisted timeline
      if (inMemory.length === 0) {
        return this.options.getSessionTimeline?.(sessionId) ?? [];
      }
      return inMemory;
    });
  }

  getSessionTimeline(sessionId: string): OrchestrationEvent[] {
    return withSpanSync("orka.orchestration.get_session_timeline", { "orka.session.id": sessionId }, () =>
      this.options.getSessionTimeline?.(sessionId) ?? this.getSessionEvents(sessionId),
    );
  }

  loadSessionEvents(sessionId: string): OrchestrationEvent[] {
    return withSpanSync("orka.orchestration.load_session_events", { "orka.session.id": sessionId }, () => {
      const timeline = this.getSessionTimeline(sessionId);
      this.log = [
        ...this.log.filter((event) => event.sessionId !== sessionId),
        ...timeline,
      ];
      return timeline;
    });
  }

  getSessionState(sessionId: string): SessionProjection {
    return withSpanSync("orka.orchestration.get_session_state", { "orka.session.id": sessionId }, () =>
      this.projectSessionState(sessionId).projection,
    );
  }

  /** Remove a completed session's events from the in-memory log. */
  evictSession(sessionId: string): void {
    this.log = this.log.filter((event) => event.sessionId !== sessionId);
    this.sessionStatusCache.delete(sessionId);
  }

  private projectSessionState(sessionId: string): DerivedSessionState {
    const projection: SessionProjection = {
      sessionId,
      status: "queued",
      currentTurnId: null,
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
      pendingRequests: [],
      timeToFirstOutputMs: null,
      bootTimeMs: null,
      avgTurnDurationMs: null,
      totalActiveDurationMs: null,
    };
    const turnDurationsMs: number[] = [];
    const turnStartedAtMs = new Map<string, number>();
    let sessionCreatedAtMs: number | null = null;
    let sessionStartedAtMs: number | null = null;
    let firstOutputAtMs: number | null = null;
    let sessionExitedAtMs: number | null = null;

    // Use in-memory events if available, otherwise fall through to persisted timeline
    const events = this.getSessionEvents(sessionId);

    for (const event of events) {

      const eventTimestampMs = toTimestampMs(event.timestamp);

      switch (event.type) {
        case "session.created":
          projection.status = "preparing";
          sessionCreatedAtMs ??= eventTimestampMs;
          break;
        case "session.started":
          projection.status = "running";
          sessionStartedAtMs ??= eventTimestampMs;
          break;
        case "session.state.changed":
          projection.status = mapRuntimeState(event.state, projection.status);
          if (event.state === "error") {
            projection.currentTurnId = null;
          }
          break;
        case "session.completed":
          projection.status = "completed";
          projection.currentTurnId = null;
          sessionExitedAtMs = eventTimestampMs;
          break;
        case "session.failed":
          projection.status = "failed";
          projection.currentTurnId = null;
          sessionExitedAtMs = eventTimestampMs;
          break;
        case "session.cancelled":
          projection.status = "cancelled";
          projection.currentTurnId = null;
          sessionExitedAtMs = eventTimestampMs;
          break;
        case "turn.started":
          setRunning(projection, event.turnId);
          if (eventTimestampMs !== null) {
            turnStartedAtMs.set(event.turnId, eventTimestampMs);
          }
          break;
        case "turn.completed": {
          setRunning(projection);
          clearCurrentTurn(projection, event.turnId);
          projection.totalCost += event.cost ?? 0;
          projection.totalTokens.input += event.tokens?.input ?? 0;
          projection.totalTokens.output += event.tokens?.output ?? 0;
          const turnDurationMs = getDurationMs(turnStartedAtMs.get(event.turnId) ?? null, eventTimestampMs);
          if (turnDurationMs !== null) {
            turnDurationsMs.push(turnDurationMs);
          }
          turnStartedAtMs.delete(event.turnId);
          break;
        }
        case "turn.aborted":
          setRunning(projection);
          clearCurrentTurn(projection, event.turnId);
          turnStartedAtMs.delete(event.turnId);
          break;
        case "user.input":
          break;
        case "content.delta":
          setRunning(projection, event.turnId);
          firstOutputAtMs ??= eventTimestampMs;
          break;
        case "item.started":
        case "item.updated":
        case "item.completed":
        case "tool.progress":
        case "task.started":
        case "task.completed":
          setRunning(projection, event.turnId);
          break;
        case "hook.started":
        case "hook.response":
        case "session.status":
        case "session.compacted":
          break;
        case "request.opened":
          setRunning(projection);
          if (!projection.pendingRequests.some((request) => request.requestId === event.requestId)) {
            projection.pendingRequests.push({
              requestId: event.requestId,
              requestType: event.requestType,
            });
          }
          break;
        case "request.resolved":
          setRunning(projection);
          projection.pendingRequests = projection.pendingRequests.filter(
            (request) => request.requestId !== event.requestId,
          );
          break;
        case "runtime.error":
          if (event.terminal) {
            projection.status = "failed";
            projection.currentTurnId = null;
          }
          break;
        case "runtime.warning":
          break;
      }
    }

    projection.bootTimeMs = getDurationMs(sessionCreatedAtMs, sessionStartedAtMs);
    projection.timeToFirstOutputMs = getDurationMs(sessionStartedAtMs, firstOutputAtMs);
    projection.totalActiveDurationMs = getDurationMs(sessionStartedAtMs, sessionExitedAtMs);
    projection.avgTurnDurationMs =
      turnDurationsMs.length > 0
        ? turnDurationsMs.reduce((total, duration) => total + duration, 0) / turnDurationsMs.length
        : null;

    return {
      projection,
      turnDurationsMs,
    };
  }
}

interface DerivedSessionState {
  projection: SessionProjection;
  turnDurationsMs: number[];
}

function clearCurrentTurn(projection: SessionProjection, turnId: string): void {
  if (!isKnownTurnId(turnId)) {
    return;
  }

  if (projection.currentTurnId === turnId) {
    projection.currentTurnId = null;
  }
}

function isKnownTurnId(turnId: string): boolean {
  return !turnId.startsWith(UNKNOWN_TURN_PREFIX);
}

function isTerminalStatus(status: SessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function mapRuntimeState(state: RuntimeSessionState, currentStatus: SessionStatus): SessionStatus {
  if (!isKnownRuntimeSessionState(state)) {
    return currentStatus;
  }

  switch (state) {
    case "starting":
    case "ready":
      return isTerminalStatus(currentStatus) ? currentStatus : "preparing";
    case "running":
    case "waiting":
      return isTerminalStatus(currentStatus) ? currentStatus : "running";
    case "stopped":
      return currentStatus;
    case "error":
      return "failed";
    default:
      return currentStatus;
  }
}

function setRunning(projection: SessionProjection, turnId?: string): void {
  if (!isTerminalStatus(projection.status)) {
    projection.status = "running";
  }

  if (turnId && isKnownTurnId(turnId)) {
    projection.currentTurnId = turnId;
  }
}

function emitLifecycleTimingSpan(sessionId: string, derivedState: DerivedSessionState): void {
  const { projection, turnDurationsMs } = derivedState;
  const attributes: Record<string, string | number | boolean> = {
    "orka.session.id": sessionId,
    "orka.timing.turn_count": turnDurationsMs.length,
  };

  if (projection.bootTimeMs !== null) {
    attributes["orka.timing.boot_ms"] = projection.bootTimeMs;
  }
  if (projection.timeToFirstOutputMs !== null) {
    attributes["orka.timing.ttfo_ms"] = projection.timeToFirstOutputMs;
  }
  if (projection.totalActiveDurationMs !== null) {
    attributes["orka.timing.total_active_ms"] = projection.totalActiveDurationMs;
  }
  if (projection.avgTurnDurationMs !== null) {
    attributes["orka.timing.avg_turn_ms"] = projection.avgTurnDurationMs;
  }

  withSpanSync("orka.session.lifecycle_timing", attributes, () => undefined);
}

function toTimestampMs(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? null : value;
}

function getDurationMs(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null || endMs < startMs) {
    return null;
  }

  return endMs - startMs;
}
