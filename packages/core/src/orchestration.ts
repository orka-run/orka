import type {
  CanonicalItemType,
  RuntimeContentStreamKind,
  RuntimeItemStatus,
  RuntimeSessionState,
  RuntimeTurnState,
} from "./provider-events";

export type OrchestrationEvent =
  | {
      type: "session.created";
      sessionId: string;
      threadId: string;
      backend: string;
      timestamp: string;
    }
  | {
      type: "session.started";
      sessionId: string;
      timestamp: string;
    }
  | {
      type: "session.state.changed";
      sessionId: string;
      state: RuntimeSessionState;
      reason?: string;
      timestamp: string;
    }
  | {
      type: "session.completed";
      sessionId: string;
      exitCode: number | null;
      timestamp: string;
    }
  | {
      type: "session.failed";
      sessionId: string;
      error: string;
      timestamp: string;
    }
  | {
      type: "session.cancelled";
      sessionId: string;
      reason?: string;
      timestamp: string;
    }
  | {
      type: "turn.started";
      sessionId: string;
      turnId: string;
      timestamp: string;
    }
  | {
      type: "turn.completed";
      sessionId: string;
      turnId: string;
      state?: RuntimeTurnState;
      stopReason?: string;
      cost?: number;
      tokens?: {
        input: number;
        output: number;
      };
      timestamp: string;
    }
  | {
      type: "turn.aborted";
      sessionId: string;
      turnId: string;
      reason: string;
      timestamp: string;
    }
  | {
      type: "content.delta";
      sessionId: string;
      turnId: string;
      streamKind: RuntimeContentStreamKind;
      delta: string;
      timestamp: string;
    }
  | {
      type: "item.started";
      sessionId: string;
      turnId: string;
      itemId: string;
      itemType: CanonicalItemType;
      status?: RuntimeItemStatus;
      title?: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: "item.updated";
      sessionId: string;
      turnId: string;
      itemId: string;
      itemType: CanonicalItemType;
      status?: RuntimeItemStatus;
      title?: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: "item.completed";
      sessionId: string;
      turnId: string;
      itemId: string;
      itemType: CanonicalItemType;
      status?: RuntimeItemStatus;
      title?: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: "request.opened";
      sessionId: string;
      requestId: string;
      requestType: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: "request.resolved";
      sessionId: string;
      requestId: string;
      decision: string;
      timestamp: string;
    }
  | {
      type: "tool.progress";
      sessionId: string;
      turnId: string;
      itemId?: string;
      toolName?: string;
      summary?: string;
      elapsedSeconds?: number;
      timestamp: string;
    }
  | {
      type: "runtime.error";
      sessionId: string;
      turnId?: string;
      itemId?: string;
      error: string;
      class?: "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown";
      terminal?: boolean;
      timestamp: string;
    }
  | {
      type: "runtime.warning";
      sessionId: string;
      turnId?: string;
      itemId?: string;
      message: string;
      timestamp: string;
    };

export type PersistedOrchestrationEvent = OrchestrationEvent & {
  provider: string;
  eventId: string;
};
