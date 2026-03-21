import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSessionResult } from "./result-parser";

const tmpDir = join(tmpdir(), "orka-result-parser-test");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeLog(name: string, lines: string[]): string {
  const path = join(tmpDir, name);
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("parseSessionResult", () => {
  describe("codex format", () => {
    const codexLines = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "false", exit_code: 1, status: "completed" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      "[orka] exit_code=0",
    ];

    test("reports exit_code=0 sessions as success", () => {
      const logFile = writeLog("codex-success.jsonl", codexLines);
      const result = parseSessionResult(logFile);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        result: "Done.",
        isError: false,
        durationMs: 0,
        costUsd: null,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreateTokens: 0,
        model: null,
        numTurns: 1,
      });
    });

    test("returns 0 duration when no session timestamps provided", () => {
      const logFile = writeLog("codex-no-session.jsonl", codexLines);
      const result = parseSessionResult(logFile);
      if (!result) throw new Error("expected result");
      expect(result.durationMs).toBe(0);
    });

    test("calculates duration from session timestamps when backend reports 0", () => {
      const logFile = writeLog("codex-with-session.jsonl", codexLines);
      const session = {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:05:30.000Z",
      };
      const result = parseSessionResult(logFile, session);
      if (!result) throw new Error("expected result");
      expect(result.durationMs).toBe(330_000); // 5m30s
    });

    test("does not override when startedAt is null", () => {
      const logFile = writeLog("codex-null-start.jsonl", codexLines);
      const session = { startedAt: null, finishedAt: "2026-01-01T00:05:00.000Z" };
      const result = parseSessionResult(logFile, session);
      if (!result) throw new Error("expected result");
      expect(result.durationMs).toBe(0);
    });

    test("does not override when finishedAt is null", () => {
      const logFile = writeLog("codex-null-end.jsonl", codexLines);
      const session = { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };
      const result = parseSessionResult(logFile, session);
      if (!result) throw new Error("expected result");
      expect(result.durationMs).toBe(0);
    });

    test("reports non-zero session exit code as error", () => {
      const logFile = writeLog("codex-failure.jsonl", [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 1 },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Failed at the end." },
        }),
        "[orka] exit_code=1",
      ]);

      const result = parseSessionResult(logFile);
      if (!result) throw new Error("expected result");
      expect(result.isError).toBe(true);
      expect(result.result).toBe("Failed at the end.");
    });

    test("falls back to explicit codex runtime errors when no exit code footer is present", () => {
      const logFile = writeLog("codex-runtime-error.jsonl", [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 1 },
        }),
        JSON.stringify({ type: "error", error: { message: "Model failed" } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Partial output" },
        }),
      ]);

      const result = parseSessionResult(logFile);
      if (!result) throw new Error("expected result");
      expect(result.isError).toBe(true);
      expect(result.result).toBe("Partial output");
    });
  });

  describe("claude-code format", () => {
    test("does not override non-zero duration from claude-code", () => {
      const lines = [
        JSON.stringify({
          type: "result",
          result: "All done",
          is_error: false,
          duration_ms: 42000,
          total_cost_usd: 0.05,
          num_turns: 3,
        }),
      ];
      const logFile = writeLog("claude-code.jsonl", lines);
      const session = {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T01:00:00.000Z",
      };
      const result = parseSessionResult(logFile, session);
      if (!result) throw new Error("expected result");
      expect(result.durationMs).toBe(42000);
    });

    test("preserves claude result parsing", () => {
      const lines = [
        JSON.stringify({
          type: "result",
          result: "Claude complete",
          is_error: true,
          duration_ms: 5000,
          total_cost_usd: 0.11,
          num_turns: 2,
          usage: {
            input_tokens: 111,
            output_tokens: 222,
            cache_read_input_tokens: 33,
            cache_creation_input_tokens: 44,
          },
        }),
      ];

      const logFile = writeLog("claude-preserved.jsonl", lines);
      const result = parseSessionResult(logFile);
      expect(result).toEqual({
        result: "Claude complete",
        isError: true,
        durationMs: 5000,
        costUsd: 0.11,
        inputTokens: 111,
        outputTokens: 222,
        cacheReadTokens: 33,
        cacheCreateTokens: 44,
        model: null,
        numTurns: 2,
      });
    });
  });

  test("returns null for missing log file", () => {
    const result = parseSessionResult("/nonexistent/path.log");
    expect(result).toBeNull();
  });
});
