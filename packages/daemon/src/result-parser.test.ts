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
  describe("codex duration fallback", () => {
    const codexLines = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
    ];

    test("returns 0 duration when no session timestamps provided", () => {
      const logFile = writeLog("codex-no-session.jsonl", codexLines);
      const result = parseSessionResult(logFile);
      expect(result).not.toBeNull();
      expect(result!.durationMs).toBe(0);
    });

    test("calculates duration from session timestamps when backend reports 0", () => {
      const logFile = writeLog("codex-with-session.jsonl", codexLines);
      const session = {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:05:30.000Z",
      };
      const result = parseSessionResult(logFile, session);
      expect(result).not.toBeNull();
      expect(result!.durationMs).toBe(330_000); // 5m30s
    });

    test("does not override when startedAt is null", () => {
      const logFile = writeLog("codex-null-start.jsonl", codexLines);
      const session = { startedAt: null, finishedAt: "2026-01-01T00:05:00.000Z" };
      const result = parseSessionResult(logFile, session);
      expect(result).not.toBeNull();
      expect(result!.durationMs).toBe(0);
    });

    test("does not override when finishedAt is null", () => {
      const logFile = writeLog("codex-null-end.jsonl", codexLines);
      const session = { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };
      const result = parseSessionResult(logFile, session);
      expect(result).not.toBeNull();
      expect(result!.durationMs).toBe(0);
    });
  });

  describe("claude-code duration preserved", () => {
    test("does not override non-zero duration from claude-code", () => {
      const lines = [
        JSON.stringify({
          type: "result",
          result: "All done",
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
      expect(result).not.toBeNull();
      expect(result!.durationMs).toBe(42000);
    });
  });

  test("returns null for missing log file", () => {
    const result = parseSessionResult("/nonexistent/path.log");
    expect(result).toBeNull();
  });
});
