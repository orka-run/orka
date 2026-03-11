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
      type: "turn.started";
      sessionId: string;
      turnId: string;
      timestamp: string;
    }
  | {
      type: "turn.completed";
      sessionId: string;
      turnId: string;
      cost?: number;
      tokens?: {
        input: number;
        output: number;
      };
      timestamp: string;
    }
  | {
      type: "content.delta";
      sessionId: string;
      turnId: string;
      delta: string;
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
    };
