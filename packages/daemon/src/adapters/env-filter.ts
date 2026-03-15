/**
 * Default safe environment variables to pass to agent subprocesses.
 * Only these vars (plus any user-specified input.env) are forwarded.
 */
const SAFE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "EDITOR",
  "VISUAL",
  "TMPDIR",
  "TZ",
]);

const SAFE_ENV_PREFIXES = ["XDG_"];

function isSafeVar(name: string): boolean {
  if (SAFE_ENV_VARS.has(name)) return true;
  return SAFE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build a filtered environment for agent subprocesses.
 * Starts from a safe subset of process.env, then merges user-specified env vars.
 */
export function buildAgentEnv(inputEnv?: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined && isSafeVar(key)) {
      filtered[key] = value;
    }
  }

  // User-specified env vars always pass through
  if (inputEnv) {
    Object.assign(filtered, inputEnv);
  }

  return filtered;
}
