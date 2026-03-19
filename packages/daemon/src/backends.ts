import { execSync } from "node:child_process";
import type { BackendKind, ReasoningEffort } from "@orka/core";
import { withSpanSync } from "./tracing";

export interface BackendCommand {
  /** The shell command string for the backend. */
  command: string;
}

interface BackendCommandOptions {
  logFile?: string;
  sessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  projectPath?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

const BACKEND_CLI: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
};

/** Check that the CLI binary for a backend is installed. Throws with install hint if not. */
export function assertBackendInstalled(backend: BackendKind): void {
  withSpanSync("orka.backend.assert_installed", { "orka.backend": backend }, () => {
    const bin = BACKEND_CLI[backend];
    if (!bin) return;

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
  });
}

/** Build the command string for a given backend + prompt. */
export function buildBackendCommand(
  backend: BackendKind,
  prompt: string,
  opts?: BackendCommandOptions,
): BackendCommand {
  return withSpanSync("orka.backend.build_command", { "orka.backend": backend }, () => {
    let cmd: string;

    switch (backend) {
      case "claude-code":
        cmd = buildClaudeCode(prompt, opts?.sessionId, opts?.model, opts?.systemPrompt, opts?.allowedTools);
        break;
      case "codex":
        cmd = buildCodex(prompt, opts?.model, opts?.reasoningEffort, opts?.systemPrompt);
        break;
    }

    // Wrap: tee output to log file and capture exit code
    if (opts?.logFile) {
      const lf = shellEscape(opts.logFile);
      cmd = `{ ${cmd} ; } 2>&1 | tee ${lf} ; echo "" >> ${lf} ; echo "[orka] exit_code=$?" >> ${lf}`;
    }

    return { command: cmd };
  });
}

function buildClaudeCode(
  prompt: string,
  sessionId?: string,
  model?: string,
  systemPrompt?: string,
  allowedTools?: string[],
): string {
  const escaped = shellEscape(prompt);
  const parts: string[] = ["claude"];
  if (model) parts.push(`--model ${shellEscape(model)}`);
  if (systemPrompt) parts.push(`--append-system-prompt ${shellEscape(systemPrompt)}`);
  if (sessionId) parts.push(`--append-system-prompt ${shellEscape(`[orka session: ${sessionId}]`)}`);
  if (allowedTools && allowedTools.length > 0) {
    parts.push(`--allowedTools ${shellEscape(allowedTools.join(","))}`);
  }
  parts.push("-p --verbose --output-format stream-json --permission-mode auto");
  parts.push(escaped);
  return parts.join(" ");
}

function buildCodex(
  prompt: string,
  model?: string,
  reasoningEffort?: ReasoningEffort,
  systemPrompt?: string,
): string {
  const escaped = shellEscape(prependSystemPrompt(prompt, systemPrompt));
  const parts: string[] = ["codex exec"];
  parts.push("--dangerously-bypass-approvals-and-sandbox");
  parts.push("--json");
  parts.push("--skip-git-repo-check");

  if (model) parts.push(`--model ${shellEscape(model)}`);
  if (reasoningEffort) parts.push(`--config model_reasoning_effort=${shellEscape(reasoningEffort)}`);
  parts.push(escaped);
  return parts.join(" ");
}

export function prependSystemPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }

  return `${systemPrompt}\n\n${prompt}`;
}

export function buildEnvExports(env?: Record<string, string>): string[] {
  if (!env) {
    return [];
  }

  return Object.entries(env).map(([key, value]) => {
    assertValidEnvKey(key);
    return `export ${key}=${shellEscape(value)}`;
  });
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function assertValidEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
}
