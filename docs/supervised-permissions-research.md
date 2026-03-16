# Supervised Permissions Research

Research into how Claude Code handles permissions in `stream-json` mode, and what mechanisms exist for programmatic tool-use approval/denial.

**Date**: 2026-03-16
**Claude Code Version**: 2.1.76
**Conclusion**: PreToolUse hooks are the correct mechanism. They provide synchronous blocking, full tool metadata on stdin, and JSON-based allow/deny/ask decisions. The current SIGSTOP-based approach in `claude-adapter.ts` should be replaced with hooks.

---

## 1. Executive Summary

There are **two viable approaches** for supervised permissions in Claude Code stream-json mode:

### Approach A: PreToolUse Hooks (RECOMMENDED)
- Claude Code natively supports `PreToolUse` hooks that fire before every tool execution
- Hooks receive full tool metadata on stdin (tool name, input args, session ID, permission mode)
- Hooks block execution synchronously until they exit
- Hooks return JSON on stdout with `permissionDecision: "allow" | "deny" | "ask"`
- Hooks can modify tool input before execution via `updatedInput`
- Works with ANY permission mode (including `bypassPermissions`)
- No SIGSTOP/SIGCONT race conditions
- The hook process can wait indefinitely for external approval (tested: blocks for seconds, polls for files, etc.)

### Approach B: SIGSTOP + Permission Mode (CURRENT - Fragile)
- Current implementation in `claude-adapter.ts` uses `--permission-mode default`
- Intercepts `assistant` events with tool_use, SIGSTOPs the process
- Waits for dashboard approval, then SIGCONTs
- Problem: In `default` mode, Claude Code auto-denies tools in non-interactive `-p` mode
- Problem: SIGSTOP races with stdio buffering
- Problem: Cannot approve -- only deny (Claude Code's permission system still blocks)

**Recommendation**: Replace SIGSTOP approach with PreToolUse hooks.

---

## 2. Test Results

### Test 1: `--permission-mode default` in stream-json

In `default` mode with `-p` (print/non-interactive), Claude Code auto-denies tool calls that need permission and reports them as errors.

**Command:**
```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"create a file called /tmp/orka-test-perm.txt with the word hello"}]}}' | claude -p --output-format stream-json --input-format stream-json --permission-mode default --verbose
```

**Key output events (abbreviated):**
```json
{"type":"system","subtype":"init","permissionMode":"default",...}

{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_011zZckUC2Dq5ph2HMLgs4J3","name":"Write","input":{"file_path":"/tmp/orka-test-perm.txt","content":"hello\n"}}]}}

{"type":"user","message":{"content":[{"type":"tool_result","content":"Claude requested permissions to write to /tmp/orka-test-perm.txt, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_011zZckUC2Dq5ph2HMLgs4J3"}]}}
```

**Result object includes `permission_denials`:**
```json
{
  "type": "result",
  "permission_denials": [
    {
      "tool_name": "Write",
      "tool_use_id": "toolu_011zZckUC2Dq5ph2HMLgs4J3",
      "tool_input": {"file_path":"/tmp/orka-test-perm.txt","content":"hello\n"}
    },
    {
      "tool_name": "Bash",
      "tool_use_id": "toolu_01KhLJxiBuKHyhZu35B9ku4T",
      "tool_input": {"command":"echo \"hello\" > /tmp/orka-test-perm.txt"}
    }
  ]
}
```

**Finding**: In `default` mode, Claude Code auto-denies tools in `-p` mode. The `permission_denials` array in the `result` event reports what was denied. There is NO interactive approval mechanism in stream-json -- the denial is automatic and immediate.

### Test 2: `--permission-mode acceptEdits` in stream-json

**Result**: Same behavior as `default` for Bash commands. Tools requiring permission are auto-denied with the error message: `"ls in '/tmp' was blocked. For security, Claude Code may only list files in the allowed working directories for this session"`.

The `permission_denials` array in the result event reports the denial.

### Test 3: `--permission-mode bypassPermissions` in stream-json

**Command:**
```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"run the command: echo orka-bypass-test"}]}}' | claude -p --output-format stream-json --input-format stream-json --permission-mode bypassPermissions --verbose
```

**Result**: Tool executes immediately without any permission check. The stream shows:
1. `system:init` with `"permissionMode":"bypassPermissions"`
2. `assistant` with tool_use
3. `user` with tool_result (success)
4. `assistant` with text response
5. `result` with `"permission_denials":[]`

**Finding**: `bypassPermissions` allows all tools. No approval mechanism.

### Test 4: Stream-json input format

The correct format for stream-json input is:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"your prompt"}]}}
```

NOT the simplified `{"type":"user","text":"..."}` format (that causes a parse error: `undefined is not an object (evaluating '$.message.role')`).

The `--verbose` flag is REQUIRED when using `--output-format stream-json` with `-p`.

---

## 3. Hooks Analysis

### 3a. Hook that allows (exit 0 + permissionDecision: "allow")

**Settings:**
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{"type": "command", "command": "cat > /tmp/stdin.json && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}' && exit 0"}]
    }]
  }
}
```

**Result**: Tool executes successfully even with `--permission-mode default`. The hook's `permissionDecision: "allow"` **overrides** the permission system.

**Hook stdin data** (full JSON):
```json
{
  "session_id": "6e1f30a9-2585-4de2-916b-ef62b84c3e60",
  "transcript_path": "/home/ilyagulya/.claude/projects/-tmp-orka-hook-test/6e1f30a9-2585-4de2-916b-ef62b84c3e60.jsonl",
  "cwd": "/tmp/orka-hook-test",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "echo hook-stdin-test",
    "description": "Print hook-stdin-test"
  },
  "tool_use_id": "toolu_01V3md2RyfAw1XN1HazPbybE"
}
```

### 3b. Hook that denies (exit 0 + permissionDecision: "deny")

**Settings:**
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{"type": "command", "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Denied by Orka supervisor - awaiting dashboard approval\"}}' && exit 0"}]
    }]
  }
}
```

**Result with `--permission-mode bypassPermissions`**: Tool is DENIED. The deny reason appears in the stream:
```json
{"type":"user","message":{"content":[{"type":"tool_result","content":"Denied by Orka supervisor - awaiting dashboard approval","is_error":true,"tool_use_id":"toolu_017GsHtzAqiUccQZQn767fWs"}]}}
```

**Critical finding**: `permissionDecision: "deny"` works even when `--permission-mode bypassPermissions` is set. Hooks override all permission modes.

### 3c. Hook that blocks (synchronous delay)

**Settings:** Hook runs `sleep 5` before responding.

**Hook log:**
```
HOOK_START 1773689171.205715354
HOOK_END 1773689176.207383958
```

**Result**: Claude Code waited the full 5 seconds for the hook to complete before executing the tool. The tool then ran successfully after approval.

**Finding**: Hooks are **fully synchronous and blocking**. Claude Code does not timeout hooks by default (configurable via `"timeout": N` in the hook config). This is perfect for external approval flows.

### 3d. External approval flow via hooks (file-based polling)

**This is the key experiment.** The hook:
1. Reads tool request from stdin and saves to `/tmp/orka-hook-tool-request.json`
2. Polls for an approval file at `/tmp/orka-approval-<tool_use_id>`
3. When file appears, reads it: "approve" -> allow, anything else -> deny
4. If timeout (20 iterations * 1s = 20s), denies

**Result**: Works perfectly.

The external process wrote the approval file 3 seconds after the hook started, and the tool executed successfully:
```json
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01TzJV4P7EtHrqeXkDVYyELR","type":"tool_result","content":"external-approval-test","is_error":false}]}}
```

**This proves the architecture**: A PreToolUse hook can block indefinitely, communicate with an external process (Orka daemon), wait for a decision, and then allow/deny the tool.

### 3e. Hook visibility in stream-json output

**PreToolUse hooks do NOT produce `hook_started`/`hook_response` events in the stream output.** Only `SessionStart` hooks produce these events. The PreToolUse hook fires silently between the `assistant` (tool_use) event and the `user` (tool_result) event.

This means:
- The Orka adapter sees the `assistant` tool_use event
- Then there's a delay (hook is blocking)
- Then the `user` tool_result event appears (with success if allowed, error if denied)
- No explicit hook events are emitted for PreToolUse

---

## 4. Stream-json Permission Protocol

### Permission-related fields in stream events

**`system:init` event:**
```json
{"type":"system","subtype":"init","permissionMode":"default|acceptEdits|bypassPermissions|dontAsk|plan|auto",...}
```

**`result` event:**
```json
{
  "type": "result",
  "permission_denials": [
    {
      "tool_name": "Write",
      "tool_use_id": "toolu_...",
      "tool_input": {...}
    }
  ]
}
```

**Auto-denied tool result (in stream):**
```json
{"type":"user","message":{"content":[{"type":"tool_result","content":"Claude requested permissions to write to /tmp/file.txt, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_..."}]}}
```

### Permission Modes

| Mode | Behavior in `-p` stream-json |
|------|------|
| `default` | Auto-denies tools that need permission |
| `acceptEdits` | Auto-allows edits, auto-denies Bash |
| `bypassPermissions` | Auto-allows all tools |
| `dontAsk` | Auto-allows read-only, auto-denies write |
| `auto` | Similar to bypassPermissions for most tools |
| `plan` | Planning mode, no tool execution |

### There is NO interactive approval in stream-json mode

In `-p` (print) mode, there is no way to send an approval response via stdin. The `--input-format stream-json` only accepts `user` message types. There is no `approval` or `permission_response` message type.

The ONLY mechanism for programmatic tool approval is **PreToolUse hooks**.

---

## 5. Recommended Architecture

### Replace SIGSTOP with PreToolUse Hooks

**Current approach** (`claude-adapter.ts` lines 669-749):
```
1. Claude Code runs with --permission-mode default
2. Adapter reads assistant event with tool_use from stdout
3. Adapter SIGSTOPs process
4. Emits request.opened, waits for dashboard decision
5. SIGCONTs process
6. Problem: Claude Code already auto-denied the tool
```

**Proposed approach**:
```
1. Claude Code runs with --permission-mode bypassPermissions
2. Orka writes a .claude/settings.json in the worktree with PreToolUse hook
3. The hook script calls back to the Orka daemon (HTTP/socket) with the tool request
4. The daemon creates an ApprovalRequest, waits for dashboard response
5. The hook script receives the decision and outputs allow/deny JSON
6. Claude Code proceeds or blocks based on the hook response
```

### Hook Script Design

The hook script (deployed to each worktree) would:

```bash
#!/bin/bash
# /path/to/worktree/.claude/hooks/supervised-hook.sh
# Reads tool request from stdin, sends to daemon, waits for approval

ORKA_DAEMON_URL="${ORKA_DAEMON_URL:-http://127.0.0.1:7394}"
SESSION_ID="${ORKA_SESSION_ID}"

# Read tool request from stdin
REQUEST=$(cat)
TOOL_NAME=$(echo "$REQUEST" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$REQUEST" | jq -c '.tool_input')
TOOL_USE_ID=$(echo "$REQUEST" | jq -r '.tool_use_id')

# Send to daemon and wait for decision
RESPONSE=$(curl -s -X POST "$ORKA_DAEMON_URL/api/approve" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"toolName\":\"$TOOL_NAME\",\"toolInput\":$TOOL_INPUT,\"toolUseId\":\"$TOOL_USE_ID\"}")

DECISION=$(echo "$RESPONSE" | jq -r '.decision')

if [ "$DECISION" = "approve" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved by Orka supervisor"}}'
else
  REASON=$(echo "$RESPONSE" | jq -r '.reason // "Denied by Orka supervisor"')
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
fi
```

**However**, using a Bun script instead of bash would be more robust:

```typescript
// /path/to/worktree/.claude/hooks/supervised-hook.ts
const request = JSON.parse(await Bun.stdin.text());
const daemonUrl = process.env.ORKA_DAEMON_URL ?? "http://127.0.0.1:7394";
const sessionId = process.env.ORKA_SESSION_ID;

const resp = await fetch(`${daemonUrl}/api/sessions/${sessionId}/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    toolName: request.tool_name,
    toolInput: request.tool_input,
    toolUseId: request.tool_use_id,
  }),
});

const { decision, reason } = await resp.json();

const output = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: decision === "approve" ? "allow" : "deny",
    permissionDecisionReason: reason ?? (decision === "approve" ? "Approved" : "Denied"),
  },
};

console.log(JSON.stringify(output));
```

### Architecture Flow

```
                Dashboard
                   |
                   | (approve/deny via WS)
                   v
              Orka Daemon
                   |
                   | (HTTP long-poll response)
                   v
            Hook Script (in worktree)
                   |
                   | (JSON on stdout)
                   v
              Claude Code
                   |
                   | (tool executes or denied)
                   v
              Stream Output
```

### Settings Injection

When spawning a supervised session, Orka would:

1. Create the worktree as normal
2. Write `.claude/settings.json` in the worktree directory:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "bun /path/to/orka/hooks/supervised-hook.ts",
        "timeout": 300
      }]
    }]
  }
}
```
3. Set environment variables `ORKA_SESSION_ID` and `ORKA_DAEMON_URL` in the spawn env
4. Use `--permission-mode bypassPermissions` (hooks override permissions anyway)

### Advantages Over Current Approach

| Aspect | SIGSTOP (current) | Hooks (proposed) |
|--------|-------------------|------------------|
| Race conditions | SIGSTOP races with stdio buffering | None -- hook blocks before execution |
| Approval works | No -- auto-denied in default mode | Yes -- hook allow overrides all modes |
| Denial works | Only via auto-deny side effect | Yes -- explicit deny with reason |
| Tool input visible | From stream parsing | Directly on hook stdin |
| Modify tool input | Not possible | Yes -- via `updatedInput` |
| Permission rules | Must check in adapter | Can apply rules in hook script |
| Process management | Complex SIGSTOP/SIGCONT | No process signals needed |
| Works with bypassPermissions | No | Yes |
| Hook events in stream | N/A | Not visible (silent) |

---

## 6. Implementation Plan

### Phase 1: Hook Script

1. Create `packages/daemon/src/hooks/supervised-hook.ts` -- a standalone Bun script that:
   - Reads tool request from stdin
   - Calls Orka daemon HTTP API to create an approval request
   - Long-polls the daemon for the decision
   - Outputs allow/deny JSON to stdout

2. Create daemon HTTP endpoint `POST /api/sessions/:id/tool-approval`:
   - Accepts: `{ toolName, toolInput, toolUseId }`
   - Creates an `ApprovalRequest` in the database
   - Pushes notification via PushHub
   - Returns the decision when it arrives (long-poll with timeout)

3. Create daemon HTTP endpoint `POST /api/sessions/:id/tool-approval/:requestId/respond`:
   - Accepts: `{ decision: "approve" | "deny", reason?: string }`
   - Resolves the long-poll from step 2

### Phase 2: Adapter Changes

4. Remove SIGSTOP/SIGCONT logic from `handleSupervisedToolUse()` in `claude-adapter.ts`
5. Remove `pendingApprovals` map -- approvals are now managed by the hook script + daemon
6. In `buildClaudeCommand()`, when `supervised`:
   - Use `--permission-mode bypassPermissions` instead of `default`
   - Add `--settings` flag pointing to a generated settings file with the hook config
7. In `startSession()`, generate the hook settings file in the worktree `.claude/settings.json`
8. Set `ORKA_SESSION_ID` and `ORKA_DAEMON_URL` in the spawn environment

### Phase 3: Permission Rules Integration

9. Move permission rule evaluation into the hook script:
   - Hook reads rules from env var or file
   - Auto-approve/auto-deny matching rules without calling the daemon
   - Only call daemon for rules that return "ask"

### Phase 4: Dashboard Integration

10. Dashboard already has approval UI from the current supervised mode
11. Update WebSocket push messages to match new approval request format
12. Add `tool_input` display in approval card (available from hook stdin)

### Notes

- The hook `timeout` should be configurable (default 300s = 5 minutes for dashboard approval)
- If the hook times out, Claude Code will treat it as a non-blocking error (exit code != 0 and != 2), so the tool will proceed. Set timeout high or handle timeout as deny in the hook.
- Actually, timeout behavior depends on Claude Code's hook timeout handling. Test needed.
- The hook script should be bundled with Orka (not generated per-session) -- only the settings.json path changes.
- Consider using `--settings` CLI flag to inject hook config instead of writing `.claude/settings.json` in the worktree (cleaner, avoids git conflicts).

### Open Questions

1. **Hook timeout behavior**: What happens when a hook exceeds its configured `timeout`? Does Claude Code kill it and proceed, or deny? Need to test.
2. **`--settings` flag**: Does `--settings /path/to/settings.json` work with hooks? This would avoid writing to `.claude/settings.json` in the worktree.
3. **Multiple hooks per event**: Can we have both the supervised hook and other project hooks? The settings show an array of hooks per event -- they should chain.
4. **Hook environment variables**: Does Claude Code pass its spawn env to hooks? The hook script needs `ORKA_SESSION_ID` and `ORKA_DAEMON_URL` from the spawned process env.

---

## Appendix A: Full Hook Documentation (from docs.anthropic.com)

### PreToolUse Hook Input Schema (stdin)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /tmp/build"
  },
  "tool_use_id": "toolu_01ABC123..."
}
```

Optional fields (for subagents):
- `agent_id`: Present only when hook fires inside a subagent
- `agent_type`: Agent name (e.g., "Explore", "security-reviewer")

### PreToolUse Hook Output Schema (stdout)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "Explanation string",
    "updatedInput": { "command": "modified command" },
    "additionalContext": "Context injected into Claude's conversation"
  }
}
```

### Exit Codes

| Exit Code | Meaning | Behavior |
|-----------|---------|----------|
| 0 | Success | Parse stdout for JSON decision |
| 2 | Blocking error | Block tool, feed stderr to Claude as error |
| Other | Non-blocking error | Show in verbose mode, continue |

### Decision Values

| Value | Behavior |
|-------|----------|
| `"allow"` | Bypass permission system, execute tool immediately |
| `"deny"` | Block tool, show reason to Claude |
| `"ask"` | Prompt user to confirm (only useful in interactive mode) |

### Tool Input Schemas (by tool name)

**Bash**: `{ "command": "...", "description": "...", "timeout": 120000, "run_in_background": false }`
**Write**: `{ "file_path": "...", "content": "..." }`
**Edit**: `{ "file_path": "...", "old_string": "...", "new_string": "...", "replace_all": false }`
**Read**: `{ "file_path": "...", "offset": 10, "limit": 50 }`
**Glob**: `{ "pattern": "**/*.ts", "path": "/dir" }`
**Grep**: `{ "pattern": "TODO", "path": "/dir", "glob": "*.ts" }`
**WebFetch**: `{ "url": "...", "prompt": "..." }`
**WebSearch**: `{ "query": "...", "allowed_domains": [...] }`
**Agent**: `{ "prompt": "...", "description": "...", "subagent_type": "Explore" }`

---

## Appendix B: Claude Code --help (Permission-Related Flags)

```
--permission-mode <mode>   Permission mode (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan", "auto")
--allowedTools <tools...>  Comma or space-separated list of tool names to allow
--disallowedTools <tools...>  Comma or space-separated list of tool names to deny
--dangerously-skip-permissions  Bypass all permission checks (no internet sandbox only)
--allow-dangerously-skip-permissions  Enable bypass option without default
--settings <file-or-json>  Path to settings JSON file or JSON string (can include hooks!)
```

The `--settings` flag is particularly relevant -- it can inject hook configuration without modifying the worktree's `.claude/settings.json`.
