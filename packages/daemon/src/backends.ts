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
  opts?: { logFile?: string; sessionId?: string; model?: string },
): BackendCommand {
  let cmd: string;

  switch (backend) {
    case "claude-code":
      cmd = buildClaudeCode(prompt, mode, opts?.sessionId, opts?.model);
      break;
    case "codex":
      cmd = buildCodex(prompt, mode, opts?.model);
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

function buildClaudeCode(prompt: string, mode: SessionMode, sessionId?: string, model?: string): string {
  const escaped = shellEscape(prompt);
  const parts: string[] = ["claude"];
  if (model) parts.push(`--model ${shellEscape(model)}`);
  if (sessionId) parts.push(`--append-system-prompt ${shellEscape(`[orka session: ${sessionId}]`)}`);
  if (mode === "background") {
    parts.push("-p --verbose --output-format stream-json --permission-mode auto");
  }
  parts.push(escaped);
  return parts.join(" ");
}

function buildCodex(prompt: string, mode: SessionMode, model?: string): string {
  const escaped = shellEscape(prompt);
  const parts: string[] = ["codex"];

  if (mode === "background") {
    // Non-interactive: codex exec --full-auto --json
    parts[0] = "codex exec";
    parts.push("--full-auto");
    parts.push("--json");
  }

  if (model) parts.push(`--model ${shellEscape(model)}`);
  parts.push(escaped);
  return parts.join(" ");
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
