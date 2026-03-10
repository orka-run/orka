import type { BackendKind, SessionMode } from "@orka/core";

export interface BackendCommand {
  /** The shell command to run inside tmux. */
  command: string;
}

/** Build the command string for a given backend + prompt. */
export function buildBackendCommand(
  backend: BackendKind,
  prompt: string,
  mode: SessionMode,
  opts?: { logFile?: string; sessionId?: string },
): BackendCommand {
  let cmd: string;

  switch (backend) {
    case "claude-code":
      cmd = buildClaudeCode(prompt, mode, opts?.sessionId);
      break;
    case "codex":
      cmd = buildCodex(prompt);
      break;
    case "aider":
      cmd = buildAider(prompt);
      break;
    case "shell":
      cmd = prompt;
      break;
  }

  // Wrap: tee output to log file + keep tmux alive after exit
  if (opts?.logFile) {
    const lf = shellEscape(opts.logFile);
    cmd = `{ ${cmd} ; } 2>&1 | tee ${lf} ; echo "" >> ${lf} ; echo "[orka] exit_code=$?" >> ${lf}`;
  }

  return { command: cmd };
}

function buildClaudeCode(prompt: string, mode: SessionMode, sessionId?: string): string {
  const escaped = shellEscape(prompt);
  // Append system prompt so claude sessions are identifiable as orka-managed
  const sysprompt = sessionId
    ? `--append-system-prompt ${shellEscape(`[orka session: ${sessionId}]`)}`
    : "";
  if (mode === "background") {
    // Non-interactive: -p flag, auto permissions
    return `claude -p --verbose --output-format stream-json --permission-mode auto ${sysprompt} ${escaped}`;
  }
  // Interactive: positional prompt starts session with initial message
  return `claude ${sysprompt} ${escaped}`;
}

function buildCodex(prompt: string): string {
  const escaped = shellEscape(prompt);
  return `codex ${escaped}`;
}

function buildAider(prompt: string): string {
  const escaped = shellEscape(prompt);
  return `aider --message ${escaped}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
