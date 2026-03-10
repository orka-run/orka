import { $ } from "bun";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getOrkaHome } from "./db";

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

/** Get the global worktrees directory (~/.orka/worktrees/). */
export function getWorktreeDir(): string {
  return join(getOrkaHome(), "worktrees");
}

/** Create a git worktree for a session. Returns the worktree path. */
export async function worktreeCreate(
  repoPath: string,
  sessionSlug: string,
  branch?: string,
): Promise<string> {
  const wtDir = getWorktreeDir();
  mkdirSync(wtDir, { recursive: true });
  const wtPath = join(wtDir, sessionSlug);

  if (branch) {
    const branchExists =
      await $`git -C ${repoPath} rev-parse --verify ${branch}`
        .quiet()
        .then(() => true)
        .catch(() => false);

    if (branchExists) {
      await $`git -C ${repoPath} worktree add ${wtPath} ${branch}`.quiet();
    } else {
      await $`git -C ${repoPath} worktree add -b ${branch} ${wtPath}`.quiet();
    }
  } else {
    await $`git -C ${repoPath} worktree add --detach ${wtPath}`.quiet();
  }

  return wtPath;
}

/** Remove a git worktree. */
export async function worktreeRemove(
  repoPath: string,
  wtPath: string,
): Promise<void> {
  await $`git -C ${repoPath} worktree remove --force ${wtPath}`.quiet();
}

/** List all orka worktrees for a given repo. */
export async function worktreeList(
  repoPath: string,
): Promise<WorktreeInfo[]> {
  const wtDir = getWorktreeDir();
  const result =
    await $`git -C ${repoPath} worktree list --porcelain`.quiet().text();

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "") {
      if (current.path?.startsWith(wtDir)) {
        worktrees.push(current as WorktreeInfo);
      }
      current = {};
    }
  }

  return worktrees;
}

/** Check if repo is a valid git repository. */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await $`git -C ${path} rev-parse --git-dir`.quiet();
    return true;
  } catch {
    return false;
  }
}
