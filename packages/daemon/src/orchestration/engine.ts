import type { ProviderRuntimeEvent, RuntimeSessionState, SessionStatus } from "@orka/core";
import type { PushHub } from "../push-hub";
import { withSpanSync } from "../tracing";
import type { OrchestrationEvent, PersistedOrchestrationEvent } from "./events";
import { mapProviderEvent } from "./ingestion";

const UNKNOWN_TURN_PREFIX = "unknown-turn:";

export interface SessionProjection {
  sessionId: string;
  status: SessionStatus;
  currentTurnId: string | null;
  totalCost: number;
  totalTokens: {
    input: number;
    output: number;
  };
  pendingRequests: Array<{ requestId: string; requestType: string }>;
}

export interface OrchestrationEngineOptions {
  pushHub?: PushHub;
  persistEvent?: (event: PersistedOrchestrationEvent) => void;
  getSessionTimeline?: (sessionId: string) => OrchestrationEvent[];
}

export class OrchestrationEngine {
  private log: OrchestrationEvent[] = [];
  private listeners: Array<(event: OrchestrationEvent) => void> = [];
  private readonly options: OrchestrationEngineOptions;

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
      (span) => {
        const orchestrationEvent = mapProviderEvent(sessionId, event);
        if (!orchestrationEvent) {
          span.addEvent("orka.orchestration.skipped");
          return;
        }

        this.options.persistEvent?.({
          ...orchestrationEvent,
          provider: event.provider,
          eventId: event.eventId,
        });
        this.log.push(orchestrationEvent);

        for (const listener of this.listeners) {
          listener(orchestrationEvent);
        }

        this.options.pushHub?.broadcast("orchestration.event", orchestrationEvent);
        this.options.pushHub?.broadcast("orchestration.sessionUpdated", {
          sessionId,
          status: this.getSessionState(sessionId).status,
        });
      },
    );
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
    return withSpanSync("orka.orchestration.get_session_events", { "orka.session.id": sessionId }, () =>
      this.log.filter((event) => event.sessionId === sessionId),
    );
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
    return withSpanSync("orka.orchestration.get_session_state", { "orka.session.id": sessionId }, () => {
      const projection: SessionProjection = {
        sessionId,
        status: "queued",
        currentTurnId: null,
        totalCost: 0,
        totalTokens: { input: 0, output: 0 },
        pendingRequests: [],
      };

      for (const event of this.log) {
        if (event.sessionId !== sessionId) {
          continue;
        }

        switch (event.type) {
          case "session.created":
            projection.status = "preparing";
            break;
          case "session.started":
            projection.status = "running";
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
            break;
          case "session.failed":
            projection.status = "failed";
            projection.currentTurnId = null;
            break;
          case "session.cancelled":
            projection.status = "cancelled";
            projection.currentTurnId = null;
            break;
          case "turn.started":
            setRunning(projection, event.turnId);
            break;
          case "turn.completed":
            setRunning(projection);
            clearCurrentTurn(projection, event.turnId);
            projection.totalCost += event.cost ?? 0;
            projection.totalTokens.input += event.tokens?.input ?? 0;
            projection.totalTokens.output += event.tokens?.output ?? 0;
            break;
          case "turn.aborted":
            setRunning(projection);
            clearCurrentTurn(projection, event.turnId);
            break;
          case "content.delta":
            setRunning(projection, event.turnId);
            break;
          case "item.started":
          case "item.updated":
          case "item.completed":
          case "tool.progress":
            setRunning(projection, event.turnId);
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

      return projection;
    });
  }
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
