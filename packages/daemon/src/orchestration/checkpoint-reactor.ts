import { withSpan } from "../tracing";
import type { OrchestrationEngine } from "./engine";
import type { OrchestrationEvent } from "./events";
import type { CheckpointService } from "./checkpoint";

export class CheckpointReactor {
  constructor(
    engine: OrchestrationEngine,
    private checkpointService: CheckpointService,
    private getWorkingDir: (sessionId: string) => string | null,
  ) {
    engine.onEvent((event) => {
      void this.handleEvent(event).catch(() => undefined);
    });
  }

  private async handleEvent(event: OrchestrationEvent): Promise<void> {
    if (event.type !== "turn.started" && event.type !== "turn.completed") {
      return;
    }

    await withSpan(
      "orka.orchestration.checkpoint_reactor.handle_event",
      {
        "orka.session.id": event.sessionId,
        "orka.turn.id": event.turnId,
        "orka.event.type": event.type,
      },
      async (span) => {
        const workingDir = this.getWorkingDir(event.sessionId);
        if (!workingDir) {
          span.addEvent("checkpoint.capture.skipped", { reason: "missing_working_dir" });
          return;
        }

        await this.checkpointService.capture(
          event.sessionId,
          event.turnId,
          event.type === "turn.started" ? "turn_start" : "turn_end",
          workingDir,
        );
      },
    );
  }
}
