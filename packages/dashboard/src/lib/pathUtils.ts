/**
 * Path resolution utilities for displaying session file paths.
 * Converts absolute paths to relative paths with context indicators.
 */

export interface ResolvedPath {
  /** What to show in the UI */
  display: string;
  /** Path classification */
  kind: "worktree" | "project" | "external";
  /** Original absolute path */
  full: string;
}

/** Matches worktree paths: <anything>/.orka/worktrees/sess-<id>/ */
const WORKTREE_PREFIX_RE = /^(.*\/\.orka\/worktrees\/sess-[^/]+)\//;

/**
 * Resolve an absolute path to a display-friendly relative path.
 *
 * - Worktree paths (contain /.orka/worktrees/sess-<id>/) → strip prefix, kind="worktree"
 * - Project paths (start with projectPath) → strip prefix, kind="project"
 * - External paths → keep full, kind="external"
 */
export function resolvePath(
  absolutePath: string,
  projectPath: string | null,
): ResolvedPath {
  // If path is not absolute, it's already relative — treat as worktree
  if (!absolutePath.startsWith("/") && !/^[A-Za-z]:\\/.test(absolutePath)) {
    return {
      display: absolutePath,
      kind: "worktree",
      full: absolutePath,
    };
  }

  // Check for worktree pattern first
  const worktreeMatch = absolutePath.match(WORKTREE_PREFIX_RE);
  if (worktreeMatch) {
    const prefix = worktreeMatch[1]! + "/";
    return {
      display: absolutePath.slice(prefix.length),
      kind: "worktree",
      full: absolutePath,
    };
  }

  // Check for project path
  if (projectPath) {
    const prefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";
    if (absolutePath.startsWith(prefix)) {
      return {
        display: absolutePath.slice(prefix.length),
        kind: "project",
        full: absolutePath,
      };
    }
    if (absolutePath === projectPath) {
      return {
        display: ".",
        kind: "project",
        full: absolutePath,
      };
    }
  }

  return {
    display: absolutePath,
    kind: "external",
    full: absolutePath,
  };
}

/**
 * Shorten all absolute paths in a text string by stripping known prefixes.
 * Handles both worktree paths and project paths.
 */
export function shortenPaths(text: string, projectPath: string | null): string {
  if (!text) return text;

  // Strip worktree prefixes: .../.orka/worktrees/sess-<id>/
  let result = text.replace(
    /\/(?:[^\s/]+\/)*\.orka\/worktrees\/sess-[^\s/]+\//g,
    "",
  );

  // Strip project path prefix
  if (projectPath) {
    const prefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";
    result = result.replaceAll(prefix, "");
  }

  return result;
}

/**
 * Extract a file path from tool args (checks common keys).
 */
export function getPathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  if (typeof obj["file_path"] === "string") return obj["file_path"];
  if (typeof obj["path"] === "string" && obj["path"].startsWith("/")) return obj["path"];
  return null;
}
