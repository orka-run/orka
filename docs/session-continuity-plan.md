# Session Continuity: Rethinking Background vs Interactive

## Status Quo

**Background mode** (default): Session receives one prompt, stdin closes, Claude Code process runs to completion, exits. Session becomes "completed". No further interaction possible.

**Interactive mode**: stdin stays open, user sends follow-ups via `orka send`. Session runs until explicitly stopped. Blocks a terminal or requires active monitoring.

**Retry**: Starts a brand-new session with the same prompt. No conversation history. Agent begins from scratch.

## Problems

1. **Can't continue a completed background session** — retry starts from scratch. No way to say "great, now also fix the tests" to a finished session.

2. **Background sessions can't ask for clarification** — if confused, the agent guesses. Supervised mode allows tool approval but not task clarification.

3. **The distinction is artificial** — users want "do this task" with option to interact if needed. They shouldn't pre-decide "will I need to talk to the agent?"

4. **Background sessions feel disposable** — no continuation, no history reuse. Each is a fresh start.

5. **Interactive sessions feel heavyweight** — they block a terminal and require active watching.

## Key Technical Discovery

Claude Code supports native session resumption:

```
--session-id <uuid>    Set a specific session ID (must be UUID)
--resume [value]       Resume a conversation by session ID
--continue             Resume the most recent conversation
--fork-session         Create new session ID when resuming
--no-session-persistence  Disable persistence (only with --print)
```

The existence of `--no-session-persistence` as a `--print`-only option confirms that `-p` (print mode) sessions **are persisted by default** and **can be resumed**. Claude Code stores conversation history in `~/.claude/projects/.../sessions/<uuid>/`.

This means: a completed background session's full conversation — including all tool calls, file reads, edits, and reasoning — can be continued by starting a **new process** with `--resume <uuid>`. No replay needed. No transcript reconstruction. Claude Code handles it natively.

## Design Options

### Option A: All Sessions Are Continuable

Every session is continuable after completion. Background = "start without interaction, but I can send follow-ups later."

**Lifecycle:**
```
preparing → running → completed ⟲ → completed (final)
                         ↑  ↓
                    continue sends new turn,
                    re-enters "running"
```

**Flow:**
1. `orka spawn "fix the login bug"` — background session
2. Agent works, completes → status: "completed"
3. User reviews diff: `orka diff sess-abc`
4. User continues: `orka continue sess-abc "also add unit tests for the fix"`
5. Daemon starts new Claude Code process with `--resume <uuid>`
6. Agent has full context from previous run, adds tests
7. Completes again → status: "completed"
8. User merges: `orka merge sess-abc`

**What changes:**
- New `continue` RPC method on OrkaService
- Store Claude Code session UUID in Orka session record (new DB column)
- Adapter gets `continueSession()` method (spawns `claude -p --resume <uuid>`)
- Provider handle re-created for the continued session
- `--auto-merge` deferred: incompatible with continue (merge explicitly when done)
- Worktree preserved across continuations

### Option B: Background with Escalation

Background by default. If agent needs clarification, emits a "question" event. Dashboard shows it, user answers. After completion, user can send follow-up.

**Flow:**
1. Agent spawned in background
2. Agent encounters ambiguity → emits question event
3. Dashboard shows question with input field
4. User answers → agent continues
5. After completion, user can continue (same as A)

**What changes:**
- Everything from Option A, plus:
- New event type: `clarification.requested`
- New adapter capability: detect when agent is asking a question vs. providing output
- Dashboard: question card UI (similar to approval card)
- Heuristic or explicit mechanism for agents to signal "I need input"

### Option C: Keep Separation, Add `continue` Command

Keep background/interactive as-is. Add `orka continue <id> "message"` that creates a **new session** linked to the original, but with conversation history loaded via `--resume`.

**Flow:**
1. Background session completes
2. `orka continue sess-abc "now fix tests"` → creates `sess-def` (new session, new worktree)
3. New session loads conversation from `sess-abc` via `--resume`
4. Separate session, separate worktree, linked by `parentSessionId`

**What changes:**
- `continue` RPC creates new session with `--resume` flag
- `parentSessionId` links continuation chain
- Each continuation is independent (own worktree, own status)
- Existing lifecycle unchanged

## Analysis

### Option A vs B vs C

| Criterion | A: Continuable | B: Escalation | C: New Session |
|-----------|---------------|----------------|----------------|
| **Complexity** | Medium | High | Low |
| **UX coherence** | Best — one session, one conversation | Best for ambiguity, but adds cognitive load | Fragmented — multiple sessions for one task |
| **Conversation continuity** | Full — same session, same context | Full, plus agent can ask questions | Partial — history via --resume, but separate session |
| **Worktree handling** | Same worktree across continues | Same worktree | New worktree per continuation — code diverges |
| **Dashboard UX** | Natural — timeline grows with each turn | Needs question card + answer input | Confusing — user must track which session is "current" |
| **Impact on existing features** | Medium — auto-merge needs guard | High — new event types, UI | Low — additive |
| **Backend support** | Claude Code only (native --resume) | Claude Code only | Claude Code only |
| **`orka wait` behavior** | Completes on each turn end | Completes on turn end, blocks on question | Each session is independent |

### Option C is the wrong model

Option C creates a new session with a new worktree for each continuation. The agent resumes conversation context via `--resume`, but it's working in a **different directory**. It can't see its own previous edits (those are in the old worktree). This defeats the purpose — the user wants to iterate on the same code.

You could share the worktree, but then you have two sessions pointing at the same worktree with no coordination. Race conditions, merge conflicts, cleanup confusion.

### Option B is premature

Escalation (agent asking questions) is valuable but orthogonal to continuation. It requires:
- A protocol for agents to signal "I need input" vs "here's output"
- Claude Code doesn't have this — there's no "question" event type in stream-json
- Heuristic detection (e.g., "the agent's last message ends with a question mark") is fragile
- Dashboard needs a new interaction pattern (question card, input field, answer routing)

This is a separate feature. It should not block continuation.

### Option A is the right model

**Recommended: All sessions are continuable.**

The mental model is simple: a session is a conversation. It can be paused and resumed. Background just means "don't require me to watch." The agent works, finishes, and waits. If the user wants more, they continue. If not, they merge or discard.

This matches how every chat product works (ChatGPT, Cursor, Claude.ai). No distinction between "sessions that can receive follow-ups" and "sessions that can't."

## Technical Implementation: Option A

### 1. Claude Code Session UUID Bridge

**Problem:** Orka session IDs are `sess-XXXXXXXX`. Claude Code session IDs are UUIDs. We need to bridge them.

**Solution:** Generate a UUID when spawning, pass it to Claude Code via `--session-id`, store it in Orka's session record.

```typescript
// packages/core/src/types.ts — add to Session interface
export interface Session {
  // ... existing fields ...
  /** Claude Code session UUID, used for --resume on continuation. */
  providerSessionId?: string;
}
```

```typescript
// packages/daemon/src/adapters/claude-adapter.ts — buildClaudeCommand
function buildClaudeCommand(input: ProviderSessionStartInput): string[] {
  const command = ["claude", "-p", "--verbose", "--output-format", "stream-json",
    "--input-format", "stream-json", "--permission-mode", permissionMode];

  if (input.providerSessionId) {
    command.push("--session-id", input.providerSessionId);
  }
  if (input.resumeSessionId) {
    command.push("--resume", input.resumeSessionId);
  }
  // ... rest unchanged
}
```

### 2. New Fields on ProviderSessionStartInput

```typescript
export interface ProviderSessionStartInput {
  // ... existing fields ...
  /** Set Claude Code's own session UUID (for future --resume). */
  providerSessionId?: string;
  /** Resume a previous Claude Code session by its UUID. */
  resumeSessionId?: string;
}
```

### 3. OrkaService: New `continue` Method

```typescript
export interface OrkaService {
  // ... existing methods ...
  /** Continue a completed session with a new user message. */
  continue(sessionId: string, prompt: string): Promise<SpawnResult>;
}
```

### 4. Orchestrator: `continueSession`

```typescript
export async function continueSession(
  ctx: DaemonContext,
  sessionId: string,
  prompt: string,
): Promise<Session> {
  const session = ctx.db.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== "completed" && session.status !== "failed") {
    throw new Error(`Cannot continue session in "${session.status}" state`);
  }
  if (!session.providerSessionId) {
    throw new Error("Session has no provider session ID — cannot resume");
  }
  if (session.backend !== "claude-code") {
    throw new Error("Continue is only supported for claude-code sessions");
  }

  // Check that the worktree still exists
  if (!existsSync(session.workingDir)) {
    throw new Error("Session worktree no longer exists — was it merged or pruned?");
  }

  // Re-start the provider with --resume
  const handle = await ctx.providerService.startSession(session.backend, {
    threadId: sessionId,
    cwd: session.workingDir,
    ...(session.model ? { model: session.model } : {}),
    prompt,
    resumeSessionId: session.providerSessionId,
    interactive: session.mode === "interactive",
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
  });

  // Update session status back to running
  const startedAt = new Date().toISOString();
  ctx.db.updateSessionStatus(sessionId, "running", { startedAt });
  ctx.db.clearFinishedAt(sessionId); // New DB method

  // Re-attach event consumer (same as spawn)
  void consumeProviderEvents(sessionId, handle, ctx.orchestrationEngine, {
    // ... same callbacks as spawnSession, re-using session's existing log file, etc.
  });

  ctx.pushHub.broadcast("orchestration.sessionUpdated", { sessionId, status: "running" });
  return { ...session, status: "running", startedAt };
}
```

### 5. Adapter Changes

The adapter needs minimal changes. `buildClaudeCommand` already builds the command array — just add `--session-id` and `--resume` support:

```typescript
// When spawning for the first time:
claude -p --session-id <uuid> --input-format stream-json --output-format stream-json ...

// When continuing:
claude -p --resume <uuid> --input-format stream-json --output-format stream-json ...
```

For `--resume`, the prompt is written to stdin as usual (same JSON format). Claude Code loads the previous conversation, appends the new message, and processes it.

### 6. Auto-Merge Guard

Auto-merge must not fire on intermediate completions. Two options:

**Option 6a: Auto-merge incompatible with continue (simple)**
- Document: if you plan to continue, don't use `--auto-merge`
- If `--auto-merge` is set, session merges on first completion — no continue possible
- User can always `orka merge <id>` manually

**Option 6b: Deferred auto-merge (more complex)**
- On completion with `--auto-merge`, start a timer (e.g., 10 minutes)
- If user sends `continue` before timer fires, cancel the timer
- If timer fires, merge

**Recommendation: 6a** (simple). Auto-merge and continue serve different workflows. Power users who iterate use `orka merge`. Automation users who fire-and-forget use `--auto-merge`.

### 7. Worktree Cleanup Guard

Current behavior: on "cancelled" completion, worktree is cleaned if no changes. On "completed", worktree is preserved if it has commits ahead.

For continue: worktree must **always be preserved** after completion (user might continue). This is already the default behavior — background sessions with commits are preserved. No change needed.

Add a guard: `tryCleanupWorktree` should not clean worktrees for sessions that have `providerSessionId` set and are "completed" (not "cancelled"). This prevents accidental cleanup of continuable sessions. The user explicitly cleans up via `orka merge`, `orka prune`, or by not continuing.

### 8. CLI: `orka continue` Command

```
orka continue <session-id> [prompt...]

Continue a completed session with a new message.

Options:
  --prompt-file <path>   Read prompt from file

Examples:
  orka continue sess-abc123 "now add unit tests"
  orka continue sess-abc123 --prompt-file followup.md
  echo "fix the edge case" | orka continue sess-abc123
```

### 9. Dashboard Changes

- **Completed session view**: Show "Continue" button next to "Retry" button
- **Continue button**: Opens the input composer (same as interactive send)
- **User types follow-up → sends → session goes back to "running"**
- **Timeline continues in-place** — new events append to existing timeline

The input composer already exists in ChatView for interactive sessions. For completed sessions, it's currently hidden. Show it when the session has a `providerSessionId` and backend is `claude-code`.

### 10. DB Schema Changes

```sql
ALTER TABLE sessions ADD COLUMN provider_session_id TEXT;
```

Migration in `db.ts` — add column, nullable. Populated on spawn for claude-code sessions.

### 11. RPC Protocol

New JSON-RPC method:
```json
{
  "method": "continue",
  "params": { "sessionId": "sess-abc123", "prompt": "now add tests" }
}
```

Response: same as `spawn` — returns `SpawnResult` with session ID and status.

## Impact on Existing Features

| Feature | Impact |
|---------|--------|
| `orka retry` | Unchanged — still creates new session from scratch |
| `orka merge` | Unchanged — user merges when done iterating |
| `orka wait` | Returns on each completion. User re-waits after continue |
| `orka stop` | Works during continued run (same as any running session) |
| `orka attach` / `orka logs -f` | Works during continued run |
| `orka send` | Works if session is running (during a continuation) |
| `orka keep` / `orka unkeep` | Unchanged |
| `orka diff` | Shows cumulative diff across all continuations |
| `orka result` | Returns result of most recent turn |
| `--auto-merge` | Fires on first completion, prevents continue |
| Dashboard timeline | Events from all turns appear in sequence |
| Worktree cleanup | Continuable sessions preserved until explicit merge/prune |
| Prune | Prune respects continuable sessions same as any completed session |

## Migration Path

### Phase 1: Foundation (backend only)
1. Add `provider_session_id` column to DB
2. Generate UUID and pass `--session-id` to Claude Code on spawn
3. Store UUID in session record
4. No user-facing changes — sessions work exactly as before

### Phase 2: Continue command
1. Add `continue` method to OrkaService interface
2. Implement in LocalClient (daemon-side)
3. Add RPC handler + RemoteClient support
4. Add `orka continue` CLI command
5. Validate: `--resume` works with Claude Code's `-p --input-format stream-json`

### Phase 3: Dashboard integration
1. Show "Continue" button on completed claude-code sessions
2. Re-enable input composer for continued sessions
3. Timeline displays continuation boundary (visual separator between turns)

### Phase 4: Polish
1. `orka result` shows results from all turns or most recent
2. Usage tracking sums across all continuations
3. Consider: continuation timeout / idle auto-close
4. Consider: `--fork-session` support for branching from a session

## What This Does NOT Change

- Background vs interactive distinction remains (controls stdin behavior within a single turn)
- Interactive sessions already support multi-turn via `orka send` — continue is for completed sessions
- Codex and shell backends don't support continue (no session persistence)
- Session status model: no new states added. "completed" → "running" → "completed" is a valid transition
- Worktree lifecycle: unchanged. Background sessions still auto-create worktrees
- Retry: still creates a new session from scratch (useful for "start over" vs "keep going")

## Future Extensions

### Agent-Initiated Questions (Option B from above)
Once continue works, escalation becomes easier:
- Agent detects ambiguity → emits content.delta with a question
- Dashboard detects question pattern → shows "Answer" button
- User answers → equivalent to `continue` with the answer
- This is a UX layer on top of continue, not a separate mechanism

### Session Branching
`--fork-session` creates a new Claude Code session from a checkpoint:
- `orka fork sess-abc "try approach B instead"` → new session `sess-def` with conversation history from `sess-abc` but diverging from there
- Useful for exploring alternatives without losing the original conversation

### Cross-Backend Continue
For Codex: replay the prompt + all assistant responses as a conversation, then add the new message. Lossy (no tool results), but provides continuity. Low priority — Codex sessions are typically more autonomous.

## Open Questions

1. **Does `--resume` work with `-p --input-format stream-json`?** Need to validate experimentally. If not, we may need to use `--continue` with `--session-id` or find another approach.

2. **Claude Code session persistence location**: Is it `~/.claude/` or relative to the project? For worktree sessions, Claude Code's session files must be accessible from the worktree path. Need to verify sessions persist correctly when cwd is a worktree.

3. **Session ID format**: `--session-id` requires UUID format. We need a UUID ↔ Orka session ID mapping. Store UUID in DB, not derive from session ID.

4. **Rate of continuation**: Should there be a limit on how many times a session can be continued? Probably not — let the user decide. But consider context window limits in Claude Code.

5. **Cost tracking**: Each continuation creates new usage records. `getResult` should aggregate across all turns, or show per-turn breakdown. Current implementation sums all `turn.completed` events, which naturally handles multiple turns.
