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

    let result: SessionResult | null = null;

    // Detect format by scanning for known event types
    // claude-code emits {"type":"result",...}
    // codex emits {"type":"turn.completed",...}
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === "result") { result = parseClaudeCodeResult(lines); break; }
        if (parsed.type === "turn.completed" || parsed.type === "thread.started") { result = parseCodexResult(lines); break; }
      } catch {
        continue;
      }
    }

    // Fallback: calculate duration from session timestamps when backend reports 0
    if (result && result.durationMs === 0 && session?.startedAt && session?.finishedAt) {
      result.durationMs = new Date(session.finishedAt).getTime() - new Date(session.startedAt).getTime();
    }

    return result;
  });
}

/** Parse claude-code stream-json log. */
function parseClaudeCodeResult(lines: string[]): SessionResult | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
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
  let hasError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

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

    // Track command failures
    if (parsed.type === "item.completed" && parsed.item?.type === "command_execution") {
      if (parsed.item.exit_code !== 0 && parsed.item.exit_code != null) {
        hasError = true;
      }
    }
  }

  if (numTurns === 0 && !lastAgentMessage) return null;

  return {
    result: lastAgentMessage,
    isError: hasError,
    durationMs: 0, // codex doesn't report duration in JSONL
    costUsd: null,  // codex doesn't report cost in JSONL
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCachedInput,
    cacheCreateTokens: 0,
    model: null,
    numTurns,
  };
}
