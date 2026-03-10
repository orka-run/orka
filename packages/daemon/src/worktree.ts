import { $ } from "bun";
import { join } from "node:path";

const WORKTREE_DIR = ".orka/worktrees";

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

/** Create a git worktree for a session. Returns the worktree path. */
export async function worktreeCreate(
  repoPath: string,
  sessionSlug: string,
  branch?: string,
): Promise<string> {
  const wtPath = join(repoPath, WORKTREE_DIR, sessionSlug);

  if (branch) {
    // Check if branch exists
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
    // Detached HEAD worktree from current HEAD
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

/** List all orka worktrees. */
export async function worktreeList(
  repoPath: string,
): Promise<WorktreeInfo[]> {
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
      if (current.path?.includes(WORKTREE_DIR)) {
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
