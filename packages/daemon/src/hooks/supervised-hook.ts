/**
 * Standalone hook script for Claude Code PreToolUse hooks.
 *
 * Claude Code invokes this script before each tool execution.
 * The script reads tool metadata from stdin and asks the Orka daemon
 * for a decision. The daemon checks permission mode (bypass/auto/supervised)
 * and either auto-approves or long-polls for a human decision.
 *
 * Environment variables:
 *   ORKA_SESSION_ID     — session ID for this Claude Code instance
 *   ORKA_DAEMON_URL     — daemon HTTP base URL (default: http://127.0.0.1:7394)
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

  let request: HookInput;
  try {
    const stdin = await Bun.stdin.text();
    request = JSON.parse(stdin);
  } catch {
    respond("deny", "Failed to parse hook input from stdin");
    return;
  }

  if (!sessionId) {
    respond("deny", "No ORKA_SESSION_ID set — cannot request approval");
    return;
  }

  // Ask daemon — it knows the current permission mode:
  // bypass → auto-approve, supervised → long-poll for human, auto → rules + fallback to human
  try {
    const resp = await fetch(`${daemonUrl}/api/sessions/${sessionId}/tool-approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: request.tool_name,
        toolInput: request.tool_input,
        toolUseId: request.tool_use_id,
      }),
    });

    if (!resp.ok) {
      respond("deny", `Daemon returned ${String(resp.status)}: ${await resp.text()}`);
      return;
    }

    const result = (await resp.json()) as { decision: string; reason?: string };
    if (result.decision === "allow" || result.decision === "approve" || result.decision === "approve_session") {
      respond("allow", result.reason ?? "Approved by daemon");
    } else {
      respond("deny", result.reason ?? "Denied by daemon");
    }
  } catch (err) {
    // Network error — daemon unreachable. Deny for safety.
    respond("deny", `Cannot reach daemon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void main();
