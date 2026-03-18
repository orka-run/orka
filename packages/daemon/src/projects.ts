import { resolve } from "node:path";
import { withSpanSync } from "./tracing";

/** Resolve a project reference to an absolute path.
 *  Without projects.json aliases, this just resolves the path.
 */
export function resolveProject(ref: string): string {
  return withSpanSync("orka.project.resolve", {}, () => resolve(ref));
}

/** Find a display name for a project path. Returns basename. */
export function projectNameForPath(_absPath: string): string | null {
  // Workspace names are now the source of truth for display names.
  // This function is retained for CLI backward compat in ps/wait/prune --project filters.
  return null;
}
