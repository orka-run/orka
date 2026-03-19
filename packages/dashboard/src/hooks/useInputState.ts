import type { OrchestrationEvent } from "@orka/core";

export type InputState = "disabled" | "waiting" | "busy" | "not_started";

/** Derive input state purely from server-provided allowedActions + event timeline.
 *  No status checks — the server decides what's allowed via allowedActions. */
export function deriveInputState(
  events: OrchestrationEvent[],
  allowedActions: string[],
): InputState {
  const canSendTurn = allowedActions.includes("sendTurn");

  if (!canSendTurn) {
    return events.length === 0 ? "not_started" : "disabled";
  }

  // Check if there's an open turn (started but not completed)
  const completedTurnIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      completedTurnIds.add(event.turnId);
    } else if (event.type === "turn.started" && !completedTurnIds.has(event.turnId)) {
      return "busy";
    }
  }

  return "waiting";
}

export function useInputState(
  events: OrchestrationEvent[],
  allowedActions: string[],
): InputState {
  return deriveInputState(events, allowedActions);
}
