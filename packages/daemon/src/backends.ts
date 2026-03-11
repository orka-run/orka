import { execSync } from "node:child_process";
import type { BackendKind, SessionMode, ReasoningEffort } from "@orka/core";

export interface BackendCommand {
  /** The shell command to run inside tmux. */
  command: string;
}

const BACKEND_CLI: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
};

/** Check that the CLI binary for a backend is installed. Throws with install hint if not. */
export function assertBackendInstalled(backend: BackendKind): void {
  const bin = BACKEND_CLI[backend];
  if (!bin) return; // shell backend — no binary to check

  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
  } catch {
    const hints: Record<string, string> = {
      "claude-code": "npm install -g @anthropic-ai/claude-code",
      codex: "bun install -g @openai/codex",
    };
    throw new Error(
      `Backend "${backend}" requires "${bin}" CLI but it's not installed.\n  Install: ${hints[backend] ?? `install ${bin}`}`,
    );
  }
}

/** Build the command string for a given backend + prompt. */
export function buildBackendCommand(
  backend: BackendKind,
  prompt: string,
  mode: SessionMode,
  opts?: { logFile?: string; sessionId?: string; model?: string; reasoningEffort?: ReasoningEffort },
): BackendCommand {
  let cmd: string;

  switch (backend) {
    case "claude-code":
      cmd = buildClaudeCode(prompt, mode, opts?.sessionId, opts?.model);
      break;
    case "codex":
      cmd = buildCodex(prompt, mode, opts?.model, opts?.reasoningEffort);
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

function buildCodex(prompt: string, mode: SessionMode, model?: string, reasoningEffort?: ReasoningEffort): string {
  const escaped = shellEscape(prompt);
  const parts: string[] = ["codex"];

  if (mode === "background") {
    // Non-interactive: codex exec with full automation
    parts[0] = "codex exec";
    parts.push("--full-auto");
    parts.push("--json");
    parts.push("--skip-git-repo-check");
  }

  if (model) parts.push(`--model ${shellEscape(model)}`);
  if (reasoningEffort) parts.push(`--config model_reasoning_effort=${shellEscape(reasoningEffort)}`);
  parts.push(escaped);
  return parts.join(" ");
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
