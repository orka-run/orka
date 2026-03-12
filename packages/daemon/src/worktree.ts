import { $ } from "bun";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getOrkaHome } from "./db";
import { getConfig } from "./config";
import { withSpan } from "./tracing";

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
  const spanBranch = branch ?? `orka/${sessionSlug}`;
  return withSpan("orka.worktree.create", {
    projectPath: repoPath,
    sessionId: sessionSlug,
    branch: spanBranch,
  }, async () => {
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

    await runPostCreateHook(wtPath, sessionSlug);

    return wtPath;
  });
}

async function runPostCreateHook(wtPath: string, sessionSlug: string): Promise<void> {
  const hookCommand = getConfig().hooks.postWorktreeCreate.trim();
  if (!hookCommand) {
    return;
  }

  try {
    await withSpan("orka.worktree.post_create_hook", {
      "orka.session.id": sessionSlug,
      "orka.command": hookCommand,
      "orka.worktree.path": wtPath,
    }, async (span) => {
      const proc = Bun.spawn(["bash", "-c", hookCommand], {
        cwd: wtPath,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      span.setAttribute("orka.exit_code", exitCode);

      if (exitCode !== 0) {
        console.warn(`Post-worktree-create hook failed for ${sessionSlug} with exit code ${exitCode}: ${hookCommand}`);
      }
    });
  } catch (error) {
    console.warn(`Post-worktree-create hook errored for ${sessionSlug}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Remove a git worktree. */
export async function worktreeRemove(
  repoPath: string,
  wtPath: string,
): Promise<void> {
  await withSpan("orka.worktree.remove", {
    repoPath,
    worktreePath: wtPath,
  }, async () => {
    await $`git -C ${repoPath} worktree remove --force ${wtPath}`.quiet();
  });
}

/** List all orka worktrees for a given repo. */
export async function worktreeList(
  repoPath: string,
): Promise<WorktreeInfo[]> {
  return withSpan("orka.worktree.list", {
    repoPath,
  }, async () => {
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
  });
}

/** Check if a worktree has commits ahead of the main branch (i.e. has new work). */
export async function worktreeHasCommitsAhead(
  repoPath: string,
  wtPath: string,
): Promise<boolean> {
  return withSpan("orka.worktree.commits_ahead", {
    repoPath,
    worktreePath: wtPath,
  }, async (span) => {
    try {
      // Get the HEAD of the main repo
      const mainHead = (await $`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
      // Get the HEAD of the worktree
      const wtHead = (await $`git -C ${wtPath} rev-parse HEAD`.quiet().text()).trim();
      if (mainHead === wtHead) {
        span.setAttribute("result", false);
        return false;
      }
      // Count commits in worktree that aren't in main
      const count = (await $`git -C ${wtPath} rev-list --count ${mainHead}..${wtHead}`.quiet().text()).trim();
      const result = parseInt(count, 10) > 0;
      span.setAttribute("result", result);
      return result;
    } catch {
      span.setAttribute("result", false);
      return false;
    }
  });
}

/** Check if a worktree has uncommitted changes. */
export async function worktreeHasChanges(wtPath: string): Promise<boolean> {
  return withSpan("orka.worktree.has_changes", {
    worktreePath: wtPath,
  }, async (span) => {
    try {
      const status = (await $`git -C ${wtPath} status --porcelain`.quiet().text()).trim();
      const result = status.length > 0;
      span.setAttribute("result", result);
      return result;
    } catch {
      span.setAttribute("result", false);
      return false;
    }
  });
}

/** Get the branch name of a worktree. */
export async function worktreeBranch(wtPath: string): Promise<string | null> {
  return withSpan("orka.worktree.branch", {
    worktreePath: wtPath,
    branch: "",
  }, async (span) => {
    try {
      const branch = (await $`git -C ${wtPath} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
      const result = branch === "HEAD" ? null : branch;
      span.setAttribute("branch", result ?? "");
      return result;
    } catch {
      span.setAttribute("branch", "");
      return null;
    }
  });
}

/** Merge a worktree's branch into the current branch of the main repo.
 *  Uses fast-forward when possible, otherwise rebases the branch onto HEAD
 *  to keep a linear history (no merge commits). */
export async function worktreeMerge(
  repoPath: string,
  wtPath: string,
): Promise<{ branch: string; commits: number }> {
  return withSpan("orka.worktree.merge", {
    repoPath,
    worktreePath: wtPath,
  }, async (span) => {
    const branch = await worktreeBranch(wtPath);
    if (!branch) throw new Error("Worktree is on detached HEAD — cannot merge");
    span.setAttribute("branch", branch);

    // Count commits to merge
    const mainHead = (await $`git -C ${repoPath} rev-parse HEAD`.quiet().text()).trim();
    const wtHead = (await $`git -C ${wtPath} rev-parse HEAD`.quiet().text()).trim();
    const countStr = (await $`git -C ${repoPath} rev-list --count ${mainHead}..${wtHead}`.quiet().text()).trim();
    const commits = parseInt(countStr, 10);
    span.setAttribute("commits", commits);
    if (commits === 0) throw new Error(`No commits to merge from branch ${branch}`);

    // Try fast-forward first (cleanest — no merge commit)
    const ffResult = await $`git -C ${repoPath} merge --ff-only ${branch}`.quiet().nothrow();
    if (ffResult.exitCode === 0) {
      span.setAttribute("merge_strategy", "fast-forward");
      return { branch, commits };
    }

    // HEAD has diverged — rebase worktree branch onto current HEAD for linear history
    await $`git -C ${wtPath} rebase ${mainHead}`.quiet();
    span.setAttribute("merge_strategy", "rebase");

    // Now fast-forward should work
    await $`git -C ${repoPath} merge --ff-only ${branch}`.quiet();

    return { branch, commits };
  });
}

/** Delete the git branch associated with a worktree (after worktree removal). */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await withSpan("orka.worktree.delete_branch", {
    repoPath,
    branch,
  }, async () => {
    await $`git -C ${repoPath} branch -d ${branch}`.quiet();
  });
}

/** Check if repo is a valid git repository. */
export async function isGitRepo(path: string): Promise<boolean> {
  return withSpan("orka.worktree.is_git_repo", {
    path,
  }, async (span) => {
    try {
      await $`git -C ${path} rev-parse --git-dir`.quiet();
      span.setAttribute("result", true);
      return true;
    } catch {
      span.setAttribute("result", false);
      return false;
    }
  });
}
