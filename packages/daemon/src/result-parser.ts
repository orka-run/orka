import { readFileSync, existsSync } from "node:fs";

export interface SessionResult {
  result: string;
  isError: boolean;
  durationMs: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string | null;
  numTurns: number;
}

/** Parse stream-json log to extract the final result event. */
export function parseSessionResult(logFile: string): SessionResult | null {
  if (!existsSync(logFile)) return null;

  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n");

  // Find the last "type":"result" line (scan from end)
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
