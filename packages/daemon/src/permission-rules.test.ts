import { describe, expect, test } from "bun:test";
import {
  evaluatePermission,
  extractToolInfo,
  getInputString,
  globMatch,
  matchesRule,
  parseRule,
  type PermissionRuleSet,
} from "./permission-rules";

describe("parseRule", () => {
  test("plain tool name", () => {
    expect(parseRule("Read")).toEqual({ tool: "Read", pattern: null });
  });

  test("tool with pattern", () => {
    expect(parseRule("Bash(git *)")).toEqual({ tool: "Bash", pattern: "git *" });
  });

  test("tool with wildcard pattern", () => {
    expect(parseRule("Bash(git:*)")).toEqual({ tool: "Bash", pattern: "git:*" });
  });

  test("tool with OR pattern", () => {
    expect(parseRule("Bash(*curl*|*wget*)")).toEqual({ tool: "Bash", pattern: "*curl*|*wget*" });
  });

  test("suffix after closing paren is appended to pattern", () => {
    expect(parseRule("Bash(rm -rf /)*")).toEqual({ tool: "Bash", pattern: "rm -rf /*" });
  });

  test("trims whitespace from tool name", () => {
    expect(parseRule("  Read  ")).toEqual({ tool: "Read", pattern: null });
  });

  test("malformed rule without closing paren treated as plain name", () => {
    expect(parseRule("Bash(open")).toEqual({ tool: "Bash(open", pattern: null });
  });

  test("empty pattern inside parens", () => {
    expect(parseRule("Bash()")).toEqual({ tool: "Bash", pattern: null });
  });
});

describe("globMatch", () => {
  test("exact match", () => {
    expect(globMatch("git status", "git status")).toBe(true);
    expect(globMatch("git status", "git diff")).toBe(false);
  });

  test("wildcard at end", () => {
    expect(globMatch("git *", "git status")).toBe(true);
    expect(globMatch("git *", "git diff --staged")).toBe(true);
    expect(globMatch("git *", "ls -la")).toBe(false);
  });

  test("wildcard at start", () => {
    expect(globMatch("*ssh*", "ssh user@host")).toBe(true);
    expect(globMatch("*ssh*", "command with ssh in it")).toBe(true);
    expect(globMatch("*ssh*", "ls -la")).toBe(false);
  });

  test("multiple wildcards", () => {
    expect(globMatch("*curl*", "curl https://example.com")).toBe(true);
    expect(globMatch("*curl*", "some curl command")).toBe(true);
  });

  test("OR patterns with pipe", () => {
    expect(globMatch("*curl*|*wget*", "curl https://evil.com")).toBe(true);
    expect(globMatch("*curl*|*wget*", "wget https://evil.com")).toBe(true);
    expect(globMatch("*curl*|*wget*", "git status")).toBe(false);
  });

  test("empty pattern matches empty string", () => {
    expect(globMatch("", "")).toBe(true);
    expect(globMatch("", "something")).toBe(false);
  });

  test("just wildcard matches everything", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
  });

  test("escapes regex special characters", () => {
    expect(globMatch("rm -rf /", "rm -rf /")).toBe(true);
    expect(globMatch("file.txt", "file.txt")).toBe(true);
    expect(globMatch("file.txt", "filextxt")).toBe(false);
  });
});

describe("getInputString", () => {
  test("extracts command for Bash", () => {
    expect(getInputString("Bash", { command: "git status" })).toBe("git status");
  });

  test("extracts file_path for Read", () => {
    expect(getInputString("Read", { file_path: "/src/config.ts" })).toBe("/src/config.ts");
  });

  test("extracts file_path for Write", () => {
    expect(getInputString("Write", { file_path: "/src/new.ts" })).toBe("/src/new.ts");
  });

  test("extracts file_path for Edit", () => {
    expect(getInputString("Edit", { file_path: "/src/old.ts" })).toBe("/src/old.ts");
  });

  test("extracts path for Glob", () => {
    expect(getInputString("Glob", { path: "/src" })).toBe("/src");
  });

  test("extracts filePath (camelCase) for Read", () => {
    expect(getInputString("Read", { filePath: "/src/config.ts" })).toBe("/src/config.ts");
  });

  test("returns empty string for no input", () => {
    expect(getInputString("Bash")).toBe("");
    expect(getInputString("Bash", {})).toBe("");
  });

  test("fallback joins string values", () => {
    expect(getInputString("Unknown", { a: "hello", b: "world", c: 42 })).toBe("hello world");
  });
});

describe("matchesRule", () => {
  test("matches tool name without pattern", () => {
    expect(matchesRule({ tool: "Read", pattern: null }, "Read")).toBe(true);
    expect(matchesRule({ tool: "Read", pattern: null }, "Bash")).toBe(false);
  });

  test("matches Bash with command pattern", () => {
    expect(matchesRule({ tool: "Bash", pattern: "git *" }, "Bash", { command: "git status" })).toBe(true);
    expect(matchesRule({ tool: "Bash", pattern: "git *" }, "Bash", { command: "rm -rf /" })).toBe(false);
  });

  test("matches file path for Write", () => {
    expect(matchesRule({ tool: "Write", pattern: "/tmp/*" }, "Write", { file_path: "/tmp/test.txt" })).toBe(true);
    expect(matchesRule({ tool: "Write", pattern: "/tmp/*" }, "Write", { file_path: "/etc/passwd" })).toBe(false);
  });

  test("tool mismatch returns false even if pattern would match", () => {
    expect(matchesRule({ tool: "Bash", pattern: "git *" }, "Read", { command: "git status" })).toBe(false);
  });
});

describe("evaluatePermission", () => {
  test("returns ask when no rules", () => {
    const rules: PermissionRuleSet = { autoApprove: [], alwaysDeny: [] };
    expect(evaluatePermission(rules, "Read")).toBe("ask");
  });

  test("auto_approve matching tool name", () => {
    const rules: PermissionRuleSet = { autoApprove: ["Read"], alwaysDeny: [] };
    expect(evaluatePermission(rules, "Read")).toBe("auto_approve");
    expect(evaluatePermission(rules, "Bash")).toBe("ask");
  });

  test("auto_approve with pattern", () => {
    const rules: PermissionRuleSet = { autoApprove: ["Bash(git *)"], alwaysDeny: [] };
    expect(evaluatePermission(rules, "Bash", { command: "git status" })).toBe("auto_approve");
    expect(evaluatePermission(rules, "Bash", { command: "rm -rf /" })).toBe("ask");
  });

  test("always_deny overrides auto_approve", () => {
    const rules: PermissionRuleSet = {
      autoApprove: ["Bash(*)"],
      alwaysDeny: ["Bash(rm -rf /*)"],
    };
    expect(evaluatePermission(rules, "Bash", { command: "git status" })).toBe("auto_approve");
    expect(evaluatePermission(rules, "Bash", { command: "rm -rf /home" })).toBe("auto_deny");
  });

  test("always_deny with OR pattern", () => {
    const rules: PermissionRuleSet = {
      autoApprove: ["Bash(*)"],
      alwaysDeny: ["Bash(*curl*|*wget*)"],
    };
    expect(evaluatePermission(rules, "Bash", { command: "curl https://evil.com" })).toBe("auto_deny");
    expect(evaluatePermission(rules, "Bash", { command: "wget https://evil.com" })).toBe("auto_deny");
    expect(evaluatePermission(rules, "Bash", { command: "git status" })).toBe("auto_approve");
  });

  test("multiple auto_approve rules", () => {
    const rules: PermissionRuleSet = {
      autoApprove: ["Read", "Glob", "Grep", "Bash(git *)", "Bash(ls *)"],
      alwaysDeny: [],
    };
    expect(evaluatePermission(rules, "Read")).toBe("auto_approve");
    expect(evaluatePermission(rules, "Glob")).toBe("auto_approve");
    expect(evaluatePermission(rules, "Grep")).toBe("auto_approve");
    expect(evaluatePermission(rules, "Bash", { command: "git diff" })).toBe("auto_approve");
    expect(evaluatePermission(rules, "Bash", { command: "ls -la" })).toBe("auto_approve");
    expect(evaluatePermission(rules, "Bash", { command: "npm install malware" })).toBe("ask");
    expect(evaluatePermission(rules, "Write")).toBe("ask");
  });

  test("no input for tool with pattern returns ask (empty string does not match pattern)", () => {
    const rules: PermissionRuleSet = { autoApprove: ["Bash(git *)"], alwaysDeny: [] };
    expect(evaluatePermission(rules, "Bash")).toBe("ask");
    expect(evaluatePermission(rules, "Bash", {})).toBe("ask");
  });

  test("file path matching for Edit", () => {
    const rules: PermissionRuleSet = {
      autoApprove: ["Edit(/src/*)"],
      alwaysDeny: ["Edit(*/secrets/*)"],
    };
    expect(evaluatePermission(rules, "Edit", { file_path: "/src/config.ts" })).toBe("auto_approve");
    expect(evaluatePermission(rules, "Edit", { file_path: "/src/secrets/key.ts" })).toBe("auto_deny");
    expect(evaluatePermission(rules, "Edit", { file_path: "/etc/passwd" })).toBe("ask");
  });
});

describe("extractToolInfo", () => {
  test("maps command_execution_approval to Bash", () => {
    const result = extractToolInfo({
      id: "req-1",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "command_execution_approval",
      detail: "git status",
      args: { command: "git status" },
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("Bash");
    expect(result.input["command"]).toBe("git status");
  });

  test("maps file_read_approval to Read", () => {
    const result = extractToolInfo({
      id: "req-2",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "file_read_approval",
      detail: "/src/config.ts",
      args: { file_path: "/src/config.ts" },
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("Read");
    expect(result.input["file_path"]).toBe("/src/config.ts");
  });

  test("maps file_change_approval to Edit", () => {
    const result = extractToolInfo({
      id: "req-3",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "file_change_approval",
      detail: "/src/config.ts",
      args: { file_path: "/src/config.ts" },
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("Edit");
    expect(result.input["file_path"]).toBe("/src/config.ts");
  });

  test("extracts tool name from detail with colon prefix", () => {
    const result = extractToolInfo({
      id: "req-4",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "command_execution_approval",
      detail: "Bash: git status",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("Bash");
    expect(result.input["command"]).toBe("git status");
  });

  test("falls back to detail for command when args has no command", () => {
    const result = extractToolInfo({
      id: "req-5",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "command_execution_approval",
      detail: "rm -rf .",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("Bash");
    expect(result.input["command"]).toBe("rm -rf .");
  });

  test("unknown request type maps to unknown", () => {
    const result = extractToolInfo({
      id: "req-6",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "tool_user_input",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("unknown");
  });

  test("handles null/undefined args gracefully", () => {
    const result = extractToolInfo({
      id: "req-7",
      sessionId: "sess-1",
      threadId: "thread-1",
      requestType: "file_read_approval",
      detail: "/src/file.ts",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(result.tool).toBe("Read");
    expect(result.input["file_path"]).toBe("/src/file.ts");
  });
});
