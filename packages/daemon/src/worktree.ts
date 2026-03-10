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
    // Auto-create a named branch so commits are not lost on detached HEAD
    const autoBranch = `orka/${sessionSlug}`;
    await $`git -C ${repoPath} worktree add -b ${autoBranch} ${wtPath}`.quiet();
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

/** Check if a worktree has commits ahead of the main branch (i.e. has new work). */
export async function worktreeHasCommitsAhead(
  repoPath: string,
  wtPath: string,
): Promise<boolean> {
  try {
    // Get the HEAD of the main repo
    const mainHead = (await $`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
    // Get the HEAD of the worktree
    const wtHead = (await $`git -C ${wtPath} rev-parse HEAD`.quiet().text()).trim();
    if (mainHead === wtHead) return false;
    // Count commits in worktree that aren't in main
    const count = (await $`git -C ${wtPath} rev-list --count ${mainHead}..${wtHead}`.quiet().text()).trim();
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

/** Check if a worktree has uncommitted changes. */
export async function worktreeHasChanges(wtPath: string): Promise<boolean> {
  try {
    const status = (await $`git -C ${wtPath} status --porcelain`.quiet().text()).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/** Get the branch name of a worktree. */
export async function worktreeBranch(wtPath: string): Promise<string | null> {
  try {
    const branch = (await $`git -C ${wtPath} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/** Merge a worktree's branch into the current branch of the main repo. */
export async function worktreeMerge(
  repoPath: string,
  wtPath: string,
): Promise<{ branch: string; commits: number }> {
  const branch = await worktreeBranch(wtPath);
  if (!branch) throw new Error("Worktree is on detached HEAD — cannot merge");

  // Count commits to merge
  const mainHead = (await $`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
  const wtHead = (await $`git -C ${wtPath} rev-parse HEAD`.quiet().text()).trim();
  const countStr = (await $`git -C ${repoPath} rev-list --count ${mainHead}..${wtHead}`.quiet().text()).trim();
  const commits = parseInt(countStr, 10);
  if (commits === 0) throw new Error(`No commits to merge from branch ${branch}`);

  // Merge the branch
  await $`git -C ${repoPath} merge ${branch} --no-edit`.quiet();

  return { branch, commits };
}

/** Delete the git branch associated with a worktree (after worktree removal). */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await $`git -C ${repoPath} branch -d ${branch}`.quiet();
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
