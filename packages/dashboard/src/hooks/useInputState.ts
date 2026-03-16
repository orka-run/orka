import type { OrchestrationEvent } from "@orka/core";

export type InputState = "disabled" | "waiting" | "busy" | "not_started";

const ACTIVE_SESSION_STATUSES = new Set(["queued", "preparing", "running"]);
const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PRESTART_SESSION_STATUSES = new Set(["queued", "preparing"]);

export function deriveInputState(
  events: OrchestrationEvent[],
  sessionStatus: string,
  backend: string,
  mode?: string,
): InputState {
  void backend;

  // Background sessions never accept input
  if (mode === "background") {
    return "disabled";
  }

  if (TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
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
        if (ACTIVE_SESSION_STATUSES.has(sessionStatus)) {
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

  return "disabled";
}

export function useInputState(
  events: OrchestrationEvent[],
  sessionStatus: string,
  backend: string,
  mode?: string,
): InputState {
  return deriveInputState(events, sessionStatus, backend, mode);
}
