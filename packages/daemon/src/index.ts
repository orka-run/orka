// --- Primary export: LocalClient implementing OrkaService ---
export { createLocalClient } from "./local-client";

// --- CLI-local utilities (not part of OrkaService) ---
export { tmuxAttach } from "./tmux";
export { getConfig } from "./config";
export type { OrkaConfig } from "./config";
export { initTracing, shutdownTracing, getTracer, withSpan, withSpanSync, setLogLevel } from "./tracing";
export type { LogLevel } from "./tracing";
export {
  addProject,
  removeProject,
  listProjects,
  resolveProject,
  projectNameForPath,
} from "./projects";
export type { ProjectEntry } from "./projects";
export { getOrkaHome } from "./db";
