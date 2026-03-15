import { describe, expect, test } from "bun:test";
import {
  buildBackendCommand,
  shellEscape,
  buildEnvExports,
  prependSystemPrompt,
} from "./backends";

describe("shellEscape", () => {
  test("wraps simple strings in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("escapes single quotes in strings", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  test("escapes multiple single quotes", () => {
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  test("does not alter strings without special characters", () => {
    expect(shellEscape("abc123")).toBe("'abc123'");
  });

  test("handles strings with spaces", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  test("handles strings with double quotes", () => {
    expect(shellEscape('say "hi"')).toBe("'say \"hi\"'");
  });

  test("handles strings with newlines", () => {
    expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
  });

  test("handles strings with backticks", () => {
    expect(shellEscape("`cmd`")).toBe("'`cmd`'");
  });

  test("handles strings with dollar signs", () => {
    expect(shellEscape("$HOME")).toBe("'$HOME'");
  });

  test("handles unicode characters", () => {
    expect(shellEscape("café ☕")).toBe("'café ☕'");
  });
});

describe("prependSystemPrompt", () => {
  test("returns prompt unchanged when no system prompt", () => {
    expect(prependSystemPrompt("do the thing")).toBe("do the thing");
    expect(prependSystemPrompt("do the thing", undefined)).toBe("do the thing");
  });

  test("prepends system prompt with double newline separator", () => {
    expect(prependSystemPrompt("task", "You are helpful")).toBe("You are helpful\n\ntask");
  });

  test("handles empty system prompt", () => {
    expect(prependSystemPrompt("task", "")).toBe("task");
  });
});

describe("buildEnvExports", () => {
  test("returns empty array when env is undefined", () => {
    expect(buildEnvExports(undefined)).toEqual([]);
  });

  test("returns empty array when env is empty", () => {
    expect(buildEnvExports({})).toEqual([]);
  });

  test("generates export statements", () => {
    const result = buildEnvExports({ FOO: "bar", BAZ: "qux" });
    expect(result).toEqual([
      "export FOO='bar'",
      "export BAZ='qux'",
    ]);
  });

  test("escapes values with single quotes", () => {
    const result = buildEnvExports({ MSG: "it's a test" });
    expect(result).toEqual(["export MSG='it'\\''s a test'"]);
  });

  test("throws on invalid env key starting with digit", () => {
    expect(() => buildEnvExports({ "1BAD": "val" })).toThrow("Invalid environment variable name");
  });

  test("throws on env key with special characters", () => {
    expect(() => buildEnvExports({ "FOO-BAR": "val" })).toThrow("Invalid environment variable name");
    expect(() => buildEnvExports({ "FOO BAR": "val" })).toThrow("Invalid environment variable name");
    expect(() => buildEnvExports({ "FOO.BAR": "val" })).toThrow("Invalid environment variable name");
  });

  test("allows underscore-prefixed keys", () => {
    const result = buildEnvExports({ _PRIVATE: "secret" });
    expect(result).toEqual(["export _PRIVATE='secret'"]);
  });

  test("allows keys with digits after first char", () => {
    const result = buildEnvExports({ VAR123: "val" });
    expect(result).toEqual(["export VAR123='val'"]);
  });
});

describe("buildBackendCommand", () => {
  describe("claude-code backend", () => {
    test("builds background mode command", () => {
      const { command } = buildBackendCommand("claude-code", "fix the bug", "background");
      expect(command).toContain("claude");
      expect(command).toContain("-p --verbose --output-format stream-json --permission-mode auto");
      expect(command).toContain("'fix the bug'");
    });

    test("builds interactive (foreground) mode command", () => {
      const { command } = buildBackendCommand("claude-code", "fix the bug", "interactive");
      expect(command).toContain("claude");
      expect(command).not.toContain("-p");
      expect(command).not.toContain("--output-format");
      expect(command).toContain("'fix the bug'");
    });

    test("includes model flag when specified", () => {
      const { command } = buildBackendCommand("claude-code", "task", "background", {
        model: "claude-opus-4-6",
      });
      expect(command).toContain("--model 'claude-opus-4-6'");
    });

    test("includes system prompt flag", () => {
      const { command } = buildBackendCommand("claude-code", "task", "background", {
        systemPrompt: "Be concise",
      });
      expect(command).toContain("--append-system-prompt 'Be concise'");
    });

    test("includes session ID as system prompt", () => {
      const { command } = buildBackendCommand("claude-code", "task", "background", {
        sessionId: "sess-abc",
      });
      expect(command).toContain("--append-system-prompt '[orka session: sess-abc]'");
    });

    test("includes allowed tools", () => {
      const { command } = buildBackendCommand("claude-code", "task", "background", {
        allowedTools: ["Bash", "Read", "Write"],
      });
      expect(command).toContain("--allowedTools 'Bash,Read,Write'");
    });

    test("escapes special characters in prompt", () => {
      const { command } = buildBackendCommand("claude-code", "it's a \"test\" $HOME", "background");
      expect(command).toContain("'it'\\''s a \"test\" $HOME'");
    });
  });

  describe("codex backend", () => {
    test("builds background mode command with exec", () => {
      const { command } = buildBackendCommand("codex", "fix the bug", "background");
      expect(command).toStartWith("codex exec");
      expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(command).toContain("--json");
      expect(command).toContain("--skip-git-repo-check");
    });

    test("builds interactive mode command without exec", () => {
      const { command } = buildBackendCommand("codex", "fix the bug", "interactive");
      expect(command).toStartWith("codex ");
      expect(command).not.toContain("exec");
      expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    test("includes model flag", () => {
      const { command } = buildBackendCommand("codex", "task", "background", {
        model: "gpt-5.4",
      });
      expect(command).toContain("--model 'gpt-5.4'");
    });

    test("includes reasoning effort config", () => {
      const { command } = buildBackendCommand("codex", "task", "background", {
        reasoningEffort: "high",
      });
      expect(command).toContain("--config model_reasoning_effort='high'");
    });

    test("prepends system prompt into the prompt text", () => {
      const { command } = buildBackendCommand("codex", "do the thing", "background", {
        systemPrompt: "Be thorough",
      });
      // Codex prepends system prompt to the prompt itself
      expect(command).toContain("Be thorough");
      expect(command).toContain("do the thing");
    });
  });

  describe("shell backend", () => {
    test("returns prompt as-is", () => {
      const { command } = buildBackendCommand("shell", "echo hello", "background");
      expect(command).toBe("echo hello");
    });

    test("does not escape or modify the command", () => {
      const cmd = 'ls -la && echo "done"';
      const { command } = buildBackendCommand("shell", cmd, "background");
      expect(command).toBe(cmd);
    });
  });

  describe("log file wrapping", () => {
    test("wraps command with tee and exit code capture when logFile specified", () => {
      const { command } = buildBackendCommand("shell", "echo hi", "background", {
        logFile: "/tmp/test.log",
      });
      expect(command).toContain("tee '/tmp/test.log'");
      expect(command).toContain("[orka] exit_code=$?");
    });

    test("escapes single quotes in log file path", () => {
      const { command } = buildBackendCommand("shell", "echo hi", "background", {
        logFile: "/tmp/it's a log.log",
      });
      expect(command).toContain("tee '/tmp/it'\\''s a log.log'");
    });
  });
});
