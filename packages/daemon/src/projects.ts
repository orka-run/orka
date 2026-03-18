import { basename, dirname, resolve } from "node:path";
import { withSpanSync } from "./tracing";

/** Resolve a project reference to an absolute path.
 *  Without projects.json aliases, this just resolves the path.
 */
export function resolveProject(ref: string): string {
  return withSpanSync("orka.project.resolve", {}, (span) => {
    const resolvedPath = resolve(ref);
    const repoPath = resolveGitProjectPath(resolvedPath);

    span.setAttribute("orka.project.input_path", resolvedPath);
    if (repoPath && repoPath !== resolvedPath) {
      span.setAttribute("orka.project.repo_path", repoPath);
      return repoPath;
    }

    return resolvedPath;
  });
}

/** Find a display name for a project path. Returns basename. */
export function projectNameForPath(_absPath: string): string | null {
  void _absPath;
  // Workspace names are now the source of truth for display names.
  // This function is retained for CLI backward compat in ps/wait/prune --project filters.
  return null;
}

function resolveGitProjectPath(projectPath: string): string | null {
  const proc = Bun.spawnSync(
    [
      "git",
      "-C",
      projectPath,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );

  if (proc.exitCode !== 0) {
    return null;
  }

  const lines = new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const [topLevel, commonDir] = lines;
  if (!topLevel) {
    return null;
  }

  if (commonDir && basename(commonDir) === ".git") {
    return dirname(commonDir);
  }

  return topLevel;
}
