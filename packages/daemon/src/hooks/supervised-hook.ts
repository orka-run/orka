/**
 * Standalone hook script for Claude Code PreToolUse hooks.
 *
 * Claude Code invokes this script before each tool execution when supervised
 * mode is active. The script reads tool metadata from stdin, evaluates
 * permission rules locally, and if needed long-polls the Orka daemon for
 * a human decision from the dashboard.
 *
 * Environment variables:
 *   ORKA_SESSION_ID     — session ID for this Claude Code instance
 *   ORKA_DAEMON_URL     — daemon HTTP base URL (default: http://127.0.0.1:7394)
 *   ORKA_PERMISSION_RULES — JSON-serialized permission rules for local evaluation
 */

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  session_id?: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

interface PermissionRuleSet {
  autoApprove: string[];
  alwaysDeny: string[];
}

interface ParsedRule {
  tool: string;
  pattern: string | null;
}

// --- Permission rule evaluation (duplicated from permission-rules.ts for standalone use) ---

function parseRule(rule: string): ParsedRule {
  const openIdx = rule.indexOf("(");
  if (openIdx === -1) {
    return { tool: rule.trim(), pattern: null };
  }

  const tool = rule.slice(0, openIdx).trim();
  const closeIdx = rule.lastIndexOf(")");
  if (closeIdx <= openIdx) {
    return { tool: rule.trim(), pattern: null };
  }

  const inner = rule.slice(openIdx + 1, closeIdx);
  const suffix = rule.slice(closeIdx + 1).trim();
  const pattern = suffix ? inner + suffix : inner;

  return { tool, pattern: pattern || null };
}

function getInputString(tool: string, input?: Record<string, unknown>): string {
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

  return Object.values(input)
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

function globMatch(pattern: string, text: string): boolean {
  if (pattern.includes("|")) {
    return pattern.split("|").some((alt) => globMatch(alt.trim(), text));
  }

  const escaped = pattern.replace(/[.+^${}()[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`, "s").test(text);
}

function matchesRule(rule: ParsedRule, tool: string, input?: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.pattern) return true;

  const inputStr = getInputString(tool, input);
  return globMatch(rule.pattern, inputStr);
}

function evaluatePermission(
  rules: PermissionRuleSet,
  tool: string,
  input?: Record<string, unknown>,
): "auto_approve" | "auto_deny" | "ask" {
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

// --- Main ---

function respond(decision: "allow" | "deny", reason: string): void {
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output) + "\n");
}

async function main(): Promise<void> {
  const daemonUrl = process.env["ORKA_DAEMON_URL"] ?? "http://127.0.0.1:7394";
  const sessionId = process.env["ORKA_SESSION_ID"] ?? "";
  const rulesJson = process.env["ORKA_PERMISSION_RULES"];

  let request: HookInput;
  try {
    const stdin = await Bun.stdin.text();
    request = JSON.parse(stdin);
  } catch {
    respond("deny", "Failed to parse hook input from stdin");
    return;
  }

  const toolName = request.tool_name;
  const toolInput = request.tool_input;

  // 1. Evaluate local permission rules first (no network roundtrip)
  if (rulesJson) {
    try {
      const rules: PermissionRuleSet = JSON.parse(rulesJson);
      const decision = evaluatePermission(rules, toolName, toolInput);

      if (decision === "auto_approve") {
        respond("allow", "Auto-approved by permission rules");
        return;
      }

      if (decision === "auto_deny") {
        respond("deny", "Auto-denied by permission rules");
        return;
      }
    } catch {
      // Rules parse failed — fall through to daemon
    }
  }

  // 2. Ask daemon — long-poll for human decision
  if (!sessionId) {
    respond("deny", "No ORKA_SESSION_ID set — cannot request approval");
    return;
  }

  try {
    const resp = await fetch(`${daemonUrl}/api/sessions/${sessionId}/tool-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName,
        toolInput,
        toolUseId: request.tool_use_id,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      respond("deny", `Daemon returned ${resp.status}: ${text}`);
      return;
    }

    const result = (await resp.json()) as { decision: string; reason?: string };

    if (result.decision === "approve") {
      respond("allow", result.reason ?? "Approved by supervisor");
    } else {
      respond("deny", result.reason ?? "Denied by supervisor");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    respond("deny", `Failed to contact daemon: ${msg}`);
  }
}

main().catch(() => {
  respond("deny", "Hook script crashed");
});
