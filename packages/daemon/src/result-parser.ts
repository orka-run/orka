import { readFileSync, existsSync } from "node:fs";
import type { SessionResult } from "@orka/core";
import { withSpanSync } from "./tracing";

export type { SessionResult } from "@orka/core";

/** Parse a session log to extract the final result. Auto-detects format (claude-code vs codex).
 *  When session timestamps are provided, they serve as fallback for backends that don't report duration. */
export function parseSessionResult(logFile: string, session?: { startedAt: string | null; finishedAt: string | null }): SessionResult | null {
  return withSpanSync("orka.result.parse", {}, () => {
    if (!existsSync(logFile)) return null;

    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n");

    const format = detectLogFormat(lines);
    const result = format === "claude"
      ? parseClaudeCodeResult(lines)
      : format === "codex"
        ? parseCodexResult(lines)
        : null;

    // Fallback: calculate duration from session timestamps when backend reports 0
    if (result && result.durationMs === 0 && session?.startedAt && session?.finishedAt) {
      result.durationMs = new Date(session.finishedAt).getTime() - new Date(session.startedAt).getTime();
    }

    return result;
  });
}

function detectLogFormat(lines: string[]): "claude" | "codex" | null {
  let sawCodexMarker = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("[orka] exit_code=")) {
      sawCodexMarker = true;
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "result") return "claude";
      if (
        parsed.type === "thread.started" ||
        parsed.type === "turn.started" ||
        parsed.type === "turn.completed" ||
        parsed.type === "item.started" ||
        parsed.type === "item.completed"
      ) {
        sawCodexMarker = true;
      }
    } catch {
      continue;
    }
  }

  return sawCodexMarker ? "codex" : null;
}

/** Parse claude-code stream-json log. */
function parseClaudeCodeResult(lines: string[]): SessionResult | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === "result") {
      const usage = parsed.usage ?? {};
      const modelUsage = parsed.modelUsage ?? {};
      const firstModel = Object.keys(modelUsage)[0] ?? null;
      const modelStats = firstModel ? modelUsage[firstModel] : {};

      return {
        result: parsed.result ?? "",
        isError: parsed.is_error ?? false,
        durationMs: parsed.duration_ms ?? 0,
        costUsd: parsed.total_cost_usd ?? null,
        inputTokens: modelStats.inputTokens ?? usage.input_tokens ?? 0,
        outputTokens: modelStats.outputTokens ?? usage.output_tokens ?? 0,
        cacheReadTokens: modelStats.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0,
        cacheCreateTokens: modelStats.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0,
        model: firstModel,
        numTurns: parsed.num_turns ?? 0,
      };
    }
  }

  return null;
}

/** Parse codex exec --json JSONL log. Aggregates usage across turns. */
function parseCodexResult(lines: string[]): SessionResult | null {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCachedInput = 0;
  let numTurns = 0;
  let lastAgentMessage = "";
  let sessionExitCode: number | null = null;
  let hasRuntimeError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const exitCode = parseOrkaExitCode(trimmed);
    if (exitCode !== null) {
      sessionExitCode = exitCode;
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed.type === "turn.completed") {
      numTurns++;
      const usage = parsed.usage ?? {};
      totalInput += usage.input_tokens ?? 0;
      totalOutput += usage.output_tokens ?? 0;
      totalCachedInput += usage.cached_input_tokens ?? 0;
    }

    if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
      lastAgentMessage = parsed.item.text ?? "";
    }

    if (parsed.type === "error") {
      hasRuntimeError = true;
    }
  }

  if (numTurns === 0 && !lastAgentMessage && sessionExitCode === null) return null;

  return {
    result: lastAgentMessage,
    isError: sessionExitCode !== null ? sessionExitCode !== 0 : hasRuntimeError,
    durationMs: 0, // codex doesn't report duration in JSONL
    costUsd: null, // codex doesn't report cost in JSONL
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCachedInput,
    cacheCreateTokens: 0,
    model: null,
    numTurns,
  };
}

function parseOrkaExitCode(line: string): number | null {
  const match = /^\[orka\]\s+exit_code=(\d+)$/.exec(line);
  const exitCode = match?.[1];
  if (!exitCode) {
    return null;
  }
  return Number.parseInt(exitCode, 10);
}
