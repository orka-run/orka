import type { OrchestrationEvent, SessionAction } from "@orka/core";

export type InputState = "disabled" | "waiting" | "busy" | "not_started";

const ACTIVE_SESSION_STATUSES = new Set(["queued", "preparing", "running", "idle", "rate_limited", "hibernated"]);
const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PRESTART_SESSION_STATUSES = new Set(["queued", "preparing"]);

export function deriveInputState(
  events: OrchestrationEvent[],
  sessionStatus: string,
  allowedActions: SessionAction[],
  backend: string,
  mode?: string,
): InputState {
  void backend;
  void mode;
  const canSendTurn = allowedActions.includes("sendTurn");

  if (TERMINAL_SESSION_STATUSES.has(sessionStatus) && !canSendTurn) {
    return "disabled";
  }

  if (events.length === 0 && PRESTART_SESSION_STATUSES.has(sessionStatus)) {
    return "not_started";
  }

  const completedTurnIds = new Set<string>();
  const completedItemIds = new Set<string>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }

    switch (event.type) {
      case "item.completed":
        completedItemIds.add(event.itemId);
        break;
      case "item.started":
        if (!completedItemIds.has(event.itemId)) {
          return "busy";
        }
        break;
      case "turn.completed":
      case "turn.aborted":
        completedTurnIds.add(event.turnId);
        if (ACTIVE_SESSION_STATUSES.has(sessionStatus) || canSendTurn) {
          return "waiting";
        }
        break;
      case "turn.started":
        if (!completedTurnIds.has(event.turnId)) {
          return "busy";
        }
        break;
      default:
        break;
    }
  }

  if ((sessionStatus === "rate_limited" || sessionStatus === "hibernated") && canSendTurn) {
    return "waiting";
  }

  return canSendTurn ? "waiting" : "disabled";
}

export function useInputState(
  events: OrchestrationEvent[],
  sessionStatus: string,
  allowedActions: SessionAction[],
  backend: string,
  mode?: string,
): InputState {
  return deriveInputState(events, sessionStatus, allowedActions, backend, mode);
}
