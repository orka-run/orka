// --- Primary exports: LocalClient + RemoteClient + Server ---
export { createLocalClient } from "./local-client";
export { createRemoteClient } from "./remote-client";
export type { RemoteClientOptions } from "./remote-client";
export { startServer } from "./server";
export type { ServerOptions } from "./server";

// --- CLI-local utilities (not part of OrkaService) ---
export type { RunnerSession, SessionRunner } from "./runner";
export { TmuxRunner, defaultRunner, tmuxAttach } from "./tmux";
export { setRunner, getRunner } from "./orchestrator";
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
export { formatLog, formatEvent, parseLine } from "./log-formatter";
export { createDrainableWorker, type DrainableWorker } from "./drainable-worker";
