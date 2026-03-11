export { spawnSession, stopSession, reapSessions, cleanupOrphanedWorktrees } from "./orchestrator";
export { tmuxList, tmuxAttach, tmuxCapture, tmuxHas, tmuxSendKeys, tmuxSendText } from "./tmux";
export { getDb, getOrkaHome } from "./db";
export {
  getSession,
  listSessions,
  getTask,
  updateSessionStatus,
  findSessionByTmux,
  deleteSessions,
  setSessionKept,
  insertSessionTags,
  getSessionTags,
  listSessionsByTag,
} from "./db";
export { getConfig } from "./config";
export type { OrkaConfig } from "./config";
export { initTracing, shutdownTracing, getTracer, withSpan, withSpanSync, setLogLevel } from "./tracing";
export type { LogLevel } from "./tracing";
export { parseSessionResult } from "./result-parser";
export type { SessionResult } from "./result-parser";
export {
  worktreeMerge,
  worktreeRemove,
  worktreeBranch,
  worktreeHasCommitsAhead,
  worktreeHasChanges,
  deleteBranch,
  getWorktreeDir,
} from "./worktree";
export {
  addProject,
  removeProject,
  listProjects,
  resolveProject,
  projectNameForPath,
} from "./projects";
export type { ProjectEntry } from "./projects";
