import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseLine, formatEvent, formatLog } from "./log-formatter";
import type { LogEvent } from "./log-formatter";

// Force NO_COLOR so ANSI codes don't interfere with assertions
const origNoColor = process.env["NO_COLOR"];

beforeEach(() => {
  process.env["NO_COLOR"] = "1";
});

afterEach(() => {
  if (origNoColor !== undefined) {
    process.env["NO_COLOR"] = origNoColor;
  } else {
    delete process.env["NO_COLOR"];
  }
});

describe("parseLine", () => {
  test("returns null for empty string", () => {
    expect(parseLine("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("\t\n")).toBeNull();
  });

  test("parses exit code line", () => {
    const event = parseLine("[orka] exit_code=0");
    expect(event).toEqual({ kind: "info", text: "exit code: 0" });
  });

  test("parses non-zero exit code", () => {
    const event = parseLine("[orka] exit_code=127");
    expect(event).toEqual({ kind: "info", text: "exit code: 127" });
  });

  test("returns plain text for non-JSON lines", () => {
    const event = parseLine("Hello world");
    expect(event).toEqual({ kind: "message", text: "Hello world" });
  });

  test("returns null for malformed JSON", () => {
    expect(parseLine("{ not json }")).toBeNull();
  });

  test("returns null for JSON with unknown type", () => {
    expect(parseLine(JSON.stringify({ type: "something_else" }))).toBeNull();
  });

  test("parses turn.started event", () => {
    const event = parseLine(JSON.stringify({ type: "turn.started" }));
    expect(event).toEqual({ kind: "system", text: "--- turn ---" });
  });

  test("parses turn.completed with usage", () => {
    const event = parseLine(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 500, output_tokens: 200 },
    }));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("info");
    expect(event!.text).toContain("500 input");
    expect(event!.text).toContain("200 output");
  });

  test("parses turn.completed with camelCase usage keys", () => {
    const event = parseLine(JSON.stringify({
      type: "turn.completed",
      usage: { inputTokens: 100, outputTokens: 50 },
    }));
    expect(event).not.toBeNull();
    expect(event!.text).toContain("100 input");
    expect(event!.text).toContain("50 output");
  });

  test("parses turn.completed without usage", () => {
    const event = parseLine(JSON.stringify({ type: "turn.completed" }));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("info");
    expect(event!.text).toContain("0 input");
  });

  test("parses result event", () => {
    const event = parseLine(JSON.stringify({ type: "result", result: "All done!" }));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("message");
    expect(event!.text).toContain("RESULT");
    expect(event!.text).toContain("All done!");
  });

  test("parses system init event", () => {
    const event = parseLine(JSON.stringify({
      type: "system",
      subtype: "init",
      model: "opus-4",
      permissionMode: "auto",
    }));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("system");
    expect(event!.text).toContain("opus-4");
    expect(event!.text).toContain("auto");
  });

  test("returns null for non-init system events", () => {
    const event = parseLine(JSON.stringify({ type: "system", subtype: "other" }));
    expect(event).toBeNull();
  });

  describe("codex events", () => {
    test("parses item.completed agent_message", () => {
      const event = parseLine(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I fixed it" },
      }));
      expect(event).toEqual({ kind: "message", text: "I fixed it" });
    });

    test("parses item.completed command_execution", () => {
      const event = parseLine(JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "file1\\nfile2",
          exit_code: 0,
        },
      }));
      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_result");
      expect((event as any).tool).toBe("ls -la");
      expect((event as any).exitCode).toBe(0);
    });

    test("parses item.completed with unknown item type returns null", () => {
      const event = parseLine(JSON.stringify({
        type: "item.completed",
        item: { type: "something_else" },
      }));
      expect(event).toBeNull();
    });

    test("returns null for item.started", () => {
      expect(parseLine(JSON.stringify({ type: "item.started" }))).toBeNull();
    });
  });

  describe("claude events", () => {
    test("parses assistant text message", () => {
      const event = parseLine(JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello there" }],
        },
      }));
      expect(event).not.toBeNull();
      expect(event!.kind).toBe("message");
      expect(event!.text).toBe("Hello there");
    });

    test("parses assistant with multiple text blocks", () => {
      const event = parseLine(JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part one" },
            { type: "text", text: "Part two" },
          ],
        },
      }));
      expect(event).not.toBeNull();
      expect(event!.text).toBe("Part one\nPart two");
    });

    test("parses assistant tool_use", () => {
      const event = parseLine(JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      }));
      expect(event).not.toBeNull();
      expect(event!.kind).toBe("tool_call");
      expect((event as any).tool).toBe("Bash");
      expect((event as any).input).toBe("ls");
    });

    test("formats tool_use for Write tool with file_path", () => {
      const event = parseLine(JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/foo.ts" } }],
        },
      }));
      expect(event).not.toBeNull();
      expect((event as any).input).toBe("/tmp/foo.ts");
    });

    test("formats tool_use for Read tool with filePath", () => {
      const event = parseLine(JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { filePath: "/tmp/bar.ts" } }],
        },
      }));
      expect(event).not.toBeNull();
      expect((event as any).input).toBe("/tmp/bar.ts");
    });

    test("returns null for assistant with empty content", () => {
      const event = parseLine(JSON.stringify({
        type: "assistant",
        message: { content: [] },
      }));
      expect(event).toBeNull();
    });

    test("returns null for assistant without message", () => {
      const event = parseLine(JSON.stringify({ type: "assistant" }));
      expect(event).toBeNull();
    });
  });

  test("parses tool_result type", () => {
    const event = parseLine(JSON.stringify({
      type: "tool_result",
      content: "result text",
    }));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("tool_result");
  });

  test("parses tool type", () => {
    const event = parseLine(JSON.stringify({
      type: "tool",
      content: "tool output",
    }));
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("tool_result");
  });
});

describe("formatEvent", () => {
  test("formats message event as plain text", () => {
    const event: LogEvent = { kind: "message", text: "Hello" };
    expect(formatEvent(event)).toBe("Hello");
  });

  test("formats tool_call event with tool name and input", () => {
    const event: LogEvent = { kind: "tool_call", tool: "Bash", input: "ls -la" };
    const result = formatEvent(event);
    expect(result).toContain("Bash");
    expect(result).toContain("ls -la");
  });

  test("formats tool_call with empty input", () => {
    const event: LogEvent = { kind: "tool_call", tool: "Bash", input: "" };
    const result = formatEvent(event);
    expect(result).toContain("Bash");
  });

  test("formats tool_result with non-zero exit code", () => {
    const event: LogEvent = { kind: "tool_result", tool: "cmd", output: "error", exitCode: 1 };
    const result = formatEvent(event);
    expect(result).toContain("cmd");
  });

  test("formats tool_result with successful output", () => {
    const event: LogEvent = { kind: "tool_result", tool: "", output: "line1\nline2" };
    const result = formatEvent(event);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  test("formats error event with ERROR prefix", () => {
    const event: LogEvent = { kind: "error", text: "something broke" };
    const result = formatEvent(event);
    expect(result).toContain("ERROR");
    expect(result).toContain("something broke");
  });

  test("formats system event", () => {
    const event: LogEvent = { kind: "system", text: "session started" };
    const result = formatEvent(event);
    expect(result).toContain("session started");
  });

  test("formats info event", () => {
    const event: LogEvent = { kind: "info", text: "exit code: 0" };
    const result = formatEvent(event);
    expect(result).toContain("exit code: 0");
  });

  test("truncates long tool_result output with '... more lines' indicator", () => {
    const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const event: LogEvent = { kind: "tool_result", tool: "", output: longOutput };
    const result = formatEvent(event);
    expect(result).toContain("line 1");
    expect(result).toContain("line 2");
    expect(result).toContain("line 3");
    expect(result).toContain("more lines");
  });
});

describe("formatLog", () => {
  test("formats a multi-line log", () => {
    const log = [
      "Hello world",
      JSON.stringify({ type: "turn.started" }),
      "[orka] exit_code=0",
    ].join("\n");

    const result = formatLog(log);
    expect(result).toContain("Hello world");
    expect(result).toContain("--- turn ---");
    expect(result).toContain("exit code: 0");
  });

  test("skips empty lines and unknown JSON", () => {
    const log = [
      "",
      "visible line",
      "",
      JSON.stringify({ type: "totally_unknown" }),
    ].join("\n");

    const result = formatLog(log);
    expect(result).toContain("visible line");
    // unknown JSON types are filtered out
    expect(result).not.toContain("totally_unknown");
  });

  test("handles empty log content", () => {
    expect(formatLog("")).toBe("");
  });

  test("handles \\r\\n line endings", () => {
    const log = "line1\r\nline2\r\n";
    const result = formatLog(log);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });
});
