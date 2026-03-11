import { $ } from "bun";
import { generateId } from "@orka/core";
import { withSpan, withSpanSync } from "../tracing";

export interface Checkpoint {
  id: string;
  sessionId: string;
  turnId: string;
  type: "turn_start" | "turn_end";
  commitHash: string;
  timestamp: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export class CheckpointService {
  private checkpoints: Checkpoint[] = [];

  /** Capture current git state as a checkpoint */
  async capture(
    sessionId: string,
    turnId: string,
    type: "turn_start" | "turn_end",
    workingDir: string,
  ): Promise<Checkpoint> {
    return withSpan(
      "orka.orchestration.checkpoint.capture",
      {
        "orka.session.id": sessionId,
        "orka.turn.id": turnId,
        "orka.checkpoint.type": type,
      },
      async (span) => {
        const commitHash = await this.getHeadCommit(workingDir);
        const checkpoint: Checkpoint = {
          id: generateId("chkpt"),
          sessionId,
          turnId,
          type,
          commitHash,
          timestamp: new Date().toISOString(),
        };

        if (type === "turn_end") {
          const lastCheckpoint = this.getLastCheckpointForSession(sessionId);
          if (lastCheckpoint) {
            const stats = await this.getDiffStats(workingDir, lastCheckpoint.commitHash, commitHash);
            checkpoint.filesChanged = stats.filesChanged;
            checkpoint.insertions = stats.insertions;
            checkpoint.deletions = stats.deletions;
          }
        }

        this.checkpoints.push(checkpoint);
        span.setAttribute("orka.checkpoint.id", checkpoint.id);
        span.setAttribute("orka.checkpoint.commit", checkpoint.commitHash);
        return checkpoint;
      },
    );
  }

  /** Get checkpoints for a session */
  getForSession(sessionId: string): Checkpoint[] {
    return withSpanSync(
      "orka.orchestration.checkpoint.get_for_session",
      { "orka.session.id": sessionId },
      () => this.checkpoints.filter((checkpoint) => checkpoint.sessionId === sessionId),
    );
  }

  /** Get diff between two checkpoints */
  async getDiffBetween(
    workingDir: string,
    fromCheckpoint: Checkpoint,
    toCheckpoint: Checkpoint,
  ): Promise<string> {
    return withSpan(
      "orka.orchestration.checkpoint.diff_between",
      {
        "orka.session.id": fromCheckpoint.sessionId,
        "orka.checkpoint.from": fromCheckpoint.id,
        "orka.checkpoint.to": toCheckpoint.id,
      },
      async () =>
        (
          await $`git -C ${workingDir} diff ${fromCheckpoint.commitHash}..${toCheckpoint.commitHash}`
            .quiet()
            .text()
        ).trim(),
    );
  }

  /** Rollback to a checkpoint */
  async rollback(workingDir: string, checkpoint: Checkpoint): Promise<void> {
    await withSpan(
      "orka.orchestration.checkpoint.rollback",
      {
        "orka.session.id": checkpoint.sessionId,
        "orka.turn.id": checkpoint.turnId,
        "orka.checkpoint.id": checkpoint.id,
      },
      async (span) => {
        await $`git -C ${workingDir} reset --hard ${checkpoint.commitHash}`.quiet();
        span.addEvent("checkpoint.rollback.completed", {
          "orka.checkpoint.commit": checkpoint.commitHash,
        });
      },
    );
  }

  private getLastCheckpointForSession(sessionId: string): Checkpoint | null {
    for (let index = this.checkpoints.length - 1; index >= 0; index -= 1) {
      const checkpoint = this.checkpoints[index];
      if (checkpoint.sessionId === sessionId) {
        return checkpoint;
      }
    }

    return null;
  }

  private async getHeadCommit(workingDir: string): Promise<string> {
    return withSpan(
      "orka.orchestration.checkpoint.resolve_head",
      { "orka.workdir": workingDir },
      async () => (await $`git -C ${workingDir} rev-parse HEAD`.quiet().text()).trim(),
    );
  }

  private async getDiffStats(workingDir: string, fromHash: string, toHash: string): Promise<DiffStats> {
    return withSpan(
      "orka.orchestration.checkpoint.diff_stats",
      {
        "orka.workdir": workingDir,
        "orka.checkpoint.from_commit": fromHash,
        "orka.checkpoint.to_commit": toHash,
      },
      async () => {
        const stat = (await $`git -C ${workingDir} diff --shortstat ${fromHash}..${toHash}`.quiet().text()).trim();

        if (!stat) {
          return { filesChanged: 0, insertions: 0, deletions: 0 };
        }

        return {
          filesChanged: this.parseStatValue(stat, /(\d+)\s+files?\s+changed/),
          insertions: this.parseStatValue(stat, /(\d+)\s+insertions?\(\+\)/),
          deletions: this.parseStatValue(stat, /(\d+)\s+deletions?\(-\)/),
        };
      },
    );
  }

  private parseStatValue(stat: string, pattern: RegExp): number {
    const match = stat.match(pattern);
    return match ? Number.parseInt(match[1]!, 10) : 0;
  }
}
