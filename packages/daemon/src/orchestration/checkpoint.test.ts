import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent } from "@orka/core";
import { OrchestrationEngine } from "./engine";
import { CheckpointReactor } from "./checkpoint-reactor";
import { CheckpointService } from "./checkpoint";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CheckpointService", () => {
  test("capture creates checkpoint with commit hash", async () => {
    const repoDir = await createTempRepo();
    const service = new CheckpointService();

    const checkpoint = await service.capture("session-1", "turn-1", "turn_start", repoDir);
    const head = (await $`git -C ${repoDir} rev-parse HEAD`.quiet().text()).trim();

    expect(checkpoint.commitHash).toBe(head);
    expect(checkpoint.type).toBe("turn_start");
    expect(checkpoint.sessionId).toBe("session-1");
    expect(checkpoint.turnId).toBe("turn-1");
  });

  test("getForSession filters correctly", async () => {
    const repoDir = await createTempRepo();
    const service = new CheckpointService();

    await service.capture("session-1", "turn-1", "turn_start", repoDir);
    await service.capture("session-2", "turn-2", "turn_start", repoDir);

    const checkpoints = service.getForSession("session-1");

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.sessionId).toBe("session-1");
  });

  test("checkpoints are stored in capture order", async () => {
    const repoDir = await createTempRepo();
    const service = new CheckpointService();

    const first = await service.capture("session-1", "turn-1", "turn_start", repoDir);
    await commitFile(repoDir, "notes.txt", "alpha\nbeta\n", "update notes");
    const second = await service.capture("session-1", "turn-1", "turn_end", repoDir);
    const third = await service.capture("session-1", "turn-2", "turn_start", repoDir);

    expect(service.getForSession("session-1").map((checkpoint) => checkpoint.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(second.filesChanged).toBe(1);
    expect(second.insertions).toBe(1);
    expect(second.deletions).toBe(0);
  });

  test("getDiffBetween returns diff string", async () => {
    const repoDir = await createTempRepo();
    const service = new CheckpointService();

    const start = await service.capture("session-1", "turn-1", "turn_start", repoDir);
    await commitFile(repoDir, "notes.txt", "alpha\nbeta\n", "add beta");
    const end = await service.capture("session-1", "turn-1", "turn_end", repoDir);

    const diff = await service.getDiffBetween(repoDir, start, end);

    expect(diff).toContain("diff --git");
    expect(diff).toContain("+beta");
  });

  test("reactor captures checkpoints for turn lifecycle events", async () => {
    const repoDir = await createTempRepo();
    const engine = new OrchestrationEngine();
    const service = new CheckpointService();
    new CheckpointReactor(engine, service, (sessionId) => (sessionId === "session-1" ? repoDir : null));

    engine.ingest(
      "session-1",
      createEvent("turn.started", "thread-1", {}, { turnId: "turn-1", createdAt: "2026-03-11T00:00:00.000Z" }),
    );

    await waitFor(async () => service.getForSession("session-1").length === 1);

    await commitFile(repoDir, "notes.txt", "alpha\nbeta\n", "add beta");

    engine.ingest(
      "session-1",
      createEvent(
        "turn.completed",
        "thread-1",
        { state: "completed", totalCostUsd: 0.1, usage: { inputTokens: 1, outputTokens: 1 } },
        { turnId: "turn-1", createdAt: "2026-03-11T00:00:01.000Z" },
      ),
    );

    await waitFor(async () => service.getForSession("session-1").length === 2);

    const checkpoints = service.getForSession("session-1");
    expect(checkpoints.map((checkpoint) => checkpoint.type)).toEqual(["turn_start", "turn_end"]);
    expect(checkpoints[1]?.filesChanged).toBe(1);
  });
});

async function createTempRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "orka-checkpoint-test-"));
  tempDirs.push(repoDir);

  await $`git -C ${repoDir} init`.quiet();
  await $`git -C ${repoDir} config user.name Orka`.quiet();
  await $`git -C ${repoDir} config user.email orka@example.com`.quiet();

  writeFileSync(join(repoDir, "notes.txt"), "alpha\n");
  await $`git -C ${repoDir} add notes.txt`.quiet();
  await $`git -C ${repoDir} commit -m initial`.quiet();

  return repoDir;
}

async function commitFile(repoDir: string, fileName: string, contents: string, message: string): Promise<void> {
  writeFileSync(join(repoDir, fileName), contents);
  await $`git -C ${repoDir} add ${fileName}`.quiet();
  await $`git -C ${repoDir} commit -m ${message}`.quiet();
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error("Timed out waiting for checkpoint capture");
}
