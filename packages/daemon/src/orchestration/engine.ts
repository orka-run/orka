import type { ProviderRuntimeEvent } from "@orka/core";
import type { PushHub } from "../push-hub";
import { withSpanSync } from "../tracing";
import type { OrchestrationEvent } from "./events";
import { mapProviderEvent } from "./ingestion";

export interface SessionProjection {
  sessionId: string;
  status: "created" | "started" | "running" | "completed" | "failed";
  currentTurnId: string | null;
  totalCost: number;
  totalTokens: {
    input: number;
    output: number;
  };
  pendingRequests: Array<{ requestId: string; requestType: string }>;
}

export class OrchestrationEngine {
  private log: OrchestrationEvent[] = [];
  private listeners: Array<(event: OrchestrationEvent) => void> = [];

  constructor(private pushHub?: PushHub) {}

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

        this.log.push(orchestrationEvent);

        for (const listener of this.listeners) {
          listener(orchestrationEvent);
        }

        this.pushHub?.broadcast("orchestration.event", orchestrationEvent);
        this.pushHub?.broadcast("orchestration.sessionUpdated", {
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

  getSessionState(sessionId: string): SessionProjection {
    return withSpanSync("orka.orchestration.get_session_state", { "orka.session.id": sessionId }, () => {
      const projection: SessionProjection = {
        sessionId,
        status: "created",
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
            projection.status = "created";
            break;
          case "session.started":
            projection.status = "started";
            break;
          case "session.completed":
            projection.status = "completed";
            projection.currentTurnId = null;
            break;
          case "session.failed":
            projection.status = "failed";
            projection.currentTurnId = null;
            break;
          case "turn.started":
            projection.status = "running";
            projection.currentTurnId = event.turnId;
            break;
          case "turn.completed":
            projection.status = "running";
            projection.currentTurnId = projection.currentTurnId === event.turnId ? null : projection.currentTurnId;
            projection.totalCost += event.cost ?? 0;
            projection.totalTokens.input += event.tokens?.input ?? 0;
            projection.totalTokens.output += event.tokens?.output ?? 0;
            break;
          case "content.delta":
            projection.status = "running";
            projection.currentTurnId = event.turnId;
            break;
          case "request.opened":
            projection.status = "running";
            projection.pendingRequests.push({
              requestId: event.requestId,
              requestType: event.requestType,
            });
            break;
          case "request.resolved":
            projection.status = "running";
            projection.pendingRequests = projection.pendingRequests.filter(
              (request) => request.requestId !== event.requestId,
            );
            break;
        }
      }

      return projection;
    });
  }
}
