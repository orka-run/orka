import { mkdtemp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateId, type Checkpoint } from "@orka/core";
import { withSpan } from "./tracing";

const CHECKPOINT_REF_PREFIX = "refs/orka/checkpoints";
const MAX_DIFF_BYTES = 10 * 1024 * 1024;
const CHECKPOINT_AUTHOR = {
  GIT_AUTHOR_NAME: "Orka Checkpoint",
  GIT_AUTHOR_EMAIL: "noreply@orka.local",
  GIT_COMMITTER_NAME: "Orka Checkpoint",
  GIT_COMMITTER_EMAIL: "noreply@orka.local",
};

export type CheckpointResult = Checkpoint;

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function captureCheckpoint(
  workingDir: string,
  sessionId: string,
  turnSeq: number,
): Promise<CheckpointResult> {
  return withSpan(
    "orka.checkpoint.capture",
    { "orka.session.id": sessionId, "orka.turn.seq": turnSeq, "orka.workdir": workingDir },
    async (span) => {
      const createdAt = new Date().toISOString();
      const gitRef = getCheckpointRef(sessionId, turnSeq);
      const checkpointId = generateId("chk");
      const tempDir = await mkdtemp(join(tmpdir(), "orka-checkpoint-"));
      const indexFile = join(tempDir, "index");

      try {
        const parentRef = (await resolveLatestReadyRef(workingDir, sessionId, turnSeq - 1)) ?? "HEAD";
        const env = {
          ...process.env,
          ...CHECKPOINT_AUTHOR,
          GIT_INDEX_FILE: indexFile,
        };

        await runGit(["read-tree", "HEAD"], workingDir, env);
        await runGit(["add", "-A", "--", "."], workingDir, env);

        const treeOid = (await runGit(["write-tree"], workingDir, env)).stdout.trim();
        const files = await parseDiffFiles(workingDir, parentRef, treeOid);
        const patch = await runGit(
          ["diff", "--patch", "--minimal", "--no-color", parentRef, treeOid],
          workingDir,
          env,
        );
        const diffBytes = Buffer.byteLength(patch.stdout, "utf8");
        span.setAttribute("orka.checkpoint.diff_bytes", diffBytes);

        if (diffBytes > MAX_DIFF_BYTES) {
          span.addEvent("checkpoint.skipped", { reason: "oversized" });
          return {
            id: checkpointId,
            sessionId,
            turnSeq,
            gitRef,
            status: "oversized",
            files,
            createdAt,
          };
        }

        const commitArgs = ["commit-tree", treeOid, "-p", parentRef, "-m", `orka checkpoint turn=${turnSeq}`];
        const commitOid = (await runGit(commitArgs, workingDir, env)).stdout.trim();
        await runGit(["update-ref", gitRef, commitOid], workingDir, env);

        span.setAttribute("orka.checkpoint.ref", gitRef);
        span.setAttribute("orka.checkpoint.commit", commitOid);

        return {
          id: checkpointId,
          sessionId,
          turnSeq,
          gitRef,
          status: "ready",
          files,
          createdAt,
        };
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.addEvent("checkpoint.capture_failed");
        return {
          id: checkpointId,
          sessionId,
          turnSeq,
          gitRef,
          status: "error",
          files: null,
          createdAt,
        };
      } finally {
        await unlink(indexFile).catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );
}

export async function getCheckpointDiff(
  workingDir: string,
  fromRef: string,
  toRef: string,
): Promise<string> {
  return withSpan(
    "orka.checkpoint.diff",
    { "orka.checkpoint.from_ref": fromRef, "orka.checkpoint.to_ref": toRef, "orka.workdir": workingDir },
    async () =>
      (
        await runGit(
          ["diff", "--patch", "--minimal", "--no-color", fromRef, toRef],
          workingDir,
        )
      ).stdout,
  );
}

export async function revertToCheckpoint(
  workingDir: string,
  checkpointRef: string,
): Promise<void> {
  await withSpan(
    "orka.checkpoint.revert",
    { "orka.checkpoint.ref": checkpointRef, "orka.workdir": workingDir },
    async () => {
      await runGit(["restore", "--source", checkpointRef, "--worktree", "--staged", "."], workingDir);
      await runGit(["clean", "-fd"], workingDir);
    },
  );
}

export async function pruneCheckpoints(
  workingDir: string,
  sessionId: string,
): Promise<void> {
  await withSpan(
    "orka.checkpoint.prune",
    { "orka.session.id": sessionId, "orka.workdir": workingDir },
    async (span) => {
      const refs = await listCheckpointRefs(workingDir, sessionId);
      span.setAttribute("orka.checkpoint.count", refs.length);
      for (const ref of refs) {
        await runGit(["update-ref", "-d", ref], workingDir);
      }
    },
  );
}

export async function deleteCheckpointRefsAfter(
  workingDir: string,
  sessionId: string,
  turnSeq: number,
): Promise<void> {
  await withSpan(
    "orka.checkpoint.delete_after",
    { "orka.session.id": sessionId, "orka.turn.seq": turnSeq, "orka.workdir": workingDir },
    async () => {
      const refs = await listCheckpointRefs(workingDir, sessionId);
      for (const ref of refs) {
        const refTurnSeq = Number.parseInt(ref.split("/").at(-1) ?? "", 10);
        if (Number.isFinite(refTurnSeq) && refTurnSeq > turnSeq) {
          await runGit(["update-ref", "-d", ref], workingDir);
        }
      }
    },
  );
}

export function getCheckpointRef(sessionId: string, turnSeq: number): string {
  return `${CHECKPOINT_REF_PREFIX}/${sessionId}/${turnSeq}`;
}

async function resolveLatestReadyRef(
  workingDir: string,
  sessionId: string,
  maxTurnSeq: number,
): Promise<string | null> {
  for (let turnSeq = maxTurnSeq; turnSeq >= 0; turnSeq -= 1) {
    const ref = getCheckpointRef(sessionId, turnSeq);
    if (await refExists(workingDir, ref)) {
      return ref;
    }
  }
  return null;
}

async function listCheckpointRefs(workingDir: string, sessionId: string): Promise<string[]> {
  const prefix = `${CHECKPOINT_REF_PREFIX}/${sessionId}`;
  const result = await runGit(["for-each-ref", "--format=%(refname)", prefix], workingDir, undefined, { allowFailure: true });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function refExists(workingDir: string, ref: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", ref], workingDir, undefined, { allowFailure: true });
  return result.exitCode === 0;
}

async function parseDiffFiles(
  workingDir: string,
  fromRef: string,
  toRef: string,
): Promise<Checkpoint["files"]> {
  const output = (
    await runGit(["diff", "--numstat", fromRef, toRef], workingDir)
  ).stdout.trim();

  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const [additionsRaw = "0", deletionsRaw = "0", path = ""] = parts;
      return {
        path,
        additions: additionsRaw === "-" ? 0 : Number.parseInt(additionsRaw, 10) || 0,
        deletions: deletionsRaw === "-" ? 0 : Number.parseInt(deletionsRaw, 10) || 0,
      };
    });
}

async function runGit(
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
  opts?: { allowFailure?: boolean },
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !opts?.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return { exitCode, stdout, stderr };
}
