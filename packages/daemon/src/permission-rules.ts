import type { ApprovalRequest } from "@orka/core";

export interface PermissionRuleSet {
  autoApprove: string[];
  alwaysDeny: string[];
}

export type RuleDecision = "auto_approve" | "auto_deny" | "ask";

export interface ParsedRule {
  tool: string;
  pattern: string | null;
}

/**
 * Evaluate permission rules for a tool invocation.
 *
 * - `always_deny` rules are checked first and take priority.
 * - `auto_approve` rules are checked second.
 * - If no rule matches, returns `"ask"`.
 */
export function evaluatePermission(
  rules: PermissionRuleSet,
  tool: string,
  input?: Record<string, unknown>,
): RuleDecision {
  for (const rule of rules.alwaysDeny) {
    if (matchesRule(parseRule(rule), tool, input)) {
      return "auto_deny";
    }
  }

  for (const rule of rules.autoApprove) {
    if (matchesRule(parseRule(rule), tool, input)) {
      return "auto_approve";
    }
  }

  return "ask";
}

/**
 * Parse a rule string into tool name and optional glob pattern.
 *
 * Formats:
 * - `"Read"` → tool=Read, pattern=null (matches any use of the tool)
 * - `"Bash(git *)"` → tool=Bash, pattern="git *"
 * - `"Bash(rm -rf /)*"` → tool=Bash, pattern="rm -rf /*" (suffix appended)
 */
export function parseRule(rule: string): ParsedRule {
  const openIdx = rule.indexOf("(");
  if (openIdx === -1) {
    return { tool: rule.trim(), pattern: null };
  }

  const tool = rule.slice(0, openIdx).trim();
  const closeIdx = rule.lastIndexOf(")");
  if (closeIdx <= openIdx) {
    // Malformed — no matching close paren, treat entire string as tool name
    return { tool: rule.trim(), pattern: null };
  }

  const inner = rule.slice(openIdx + 1, closeIdx);
  const suffix = rule.slice(closeIdx + 1).trim();
  const pattern = suffix ? inner + suffix : inner;

  return { tool, pattern: pattern || null };
}

/**
 * Extract a matchable input string from the tool's args based on tool type.
 *
 * - Bash → `args.command`
 * - Read/Write/Edit/Glob/Grep → `args.file_path` or `args.path`
 * - Fallback: join all string values from args
 */
export function getInputString(tool: string, input?: Record<string, unknown>): string {
  if (!input) return "";

  if (tool === "Bash") {
    if (typeof input.command === "string") return input.command;
    if (typeof input.cmd === "string") return input.cmd;
  }

  if (tool === "Read" || tool === "Write" || tool === "Edit" || tool === "Glob" || tool === "Grep") {
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.filePath === "string") return input.filePath;
    if (typeof input.path === "string") return input.path;
  }

  // Fallback: concatenate all string-valued args
  return Object.values(input)
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

/**
 * Test whether a parsed rule matches the given tool name and input.
 */
export function matchesRule(
  rule: ParsedRule,
  tool: string,
  input?: Record<string, unknown>,
): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.pattern) return true;

  const inputStr = getInputString(tool, input);
  return globMatch(rule.pattern, inputStr);
}

/**
 * Glob-style pattern matching.
 *
 * - `*` matches any sequence of characters (including empty).
 * - `|` separates alternatives (OR).
 * - All other characters are matched literally.
 */
export function globMatch(pattern: string, text: string): boolean {
  if (pattern.includes("|")) {
    return pattern.split("|").some((alt) => globMatch(alt.trim(), text));
  }

  // Convert glob to regex: escape regex special chars, then replace * with .*
  const escaped = pattern.replace(/[.+^${}()[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`, "s").test(text);
}

/**
 * Extract tool name and input record from an ApprovalRequest.
 *
 * Maps canonical request types to tool names:
 * - command_execution_approval → "Bash"
 * - file_read_approval → "Read"
 * - file_change_approval → "Edit"
 *
 * Falls back to parsing the `detail` field for tool name, or "unknown".
 */
export function extractToolInfo(request: ApprovalRequest): {
  tool: string;
  input: Record<string, unknown>;
} {
  const args =
    request.args !== null && request.args !== undefined && typeof request.args === "object"
      ? (request.args as Record<string, unknown>)
      : {};

  // Try to get tool name from detail field (format: "ToolName: description" or "ToolName description")
  if (request.detail) {
    const colonMatch = request.detail.match(/^(\w+):\s/);
    if (colonMatch) {
      const tool = colonMatch[1]!;
      // If the detail contains the full command, inject it as 'command' for Bash matching
      if (tool === "Bash" && !args.command) {
        const cmd = request.detail.slice(request.detail.indexOf(":") + 1).trim();
        return { tool, input: { ...args, command: cmd } };
      }
      return { tool, input: args };
    }
  }

  // Map requestType to a canonical tool name
  switch (request.requestType) {
    case "command_execution_approval":
      // If args has a detail or command field, use that
      if (!args.command && request.detail) {
        return { tool: "Bash", input: { ...args, command: request.detail } };
      }
      return { tool: "Bash", input: args };
    case "file_read_approval":
      if (!args.file_path && request.detail) {
        return { tool: "Read", input: { ...args, file_path: request.detail } };
      }
      return { tool: "Read", input: args };
    case "file_change_approval":
      if (!args.file_path && request.detail) {
        return { tool: "Edit", input: { ...args, file_path: request.detail } };
      }
      return { tool: "Edit", input: args };
    default:
      return { tool: "unknown", input: args };
  }
}
