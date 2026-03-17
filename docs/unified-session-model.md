# Unified Session Model

## TL;DR

Remove the background/interactive distinction. All sessions are multi-turn by default. Process stays alive between turns (idle). Auto-hibernate after timeout. Resume transparently on next message.

## Experiment Results

### 1. Multi-Turn stream-json (Confirmed)

```bash
(echo '{"type":"user","message":...,"text":"say hello"}}';
 sleep 5;
 echo '{"type":"user","message":...,"text":"now say goodbye"}}') \
| claude -p --output-format stream-json --input-format stream-json --verbose
```

**Result**: Process stayed alive after first response. Second message processed with full context.

- Two separate `result` events (one per turn)
- Two separate `system.init` events (one per turn)
- Same `session_id` across both turns
- Cost tracked independently per turn ($0.092 + $0.104)

**Conclusion**: `claude -p --input-format stream-json` natively supports multi-turn. Process waits for next stdin message after each turn completes.

### 2. --resume Latency

| Metric | Fresh start | --resume |
|--------|-------------|----------|
| Wall clock | 3.9s | 6.6s |
| API time | 2.1s | 4.9s |
| Startup overhead | ~1.8s | ~1.7s |

Resume adds ~2.8s API overhead for replaying session history. This is per-resume — longer sessions will cost more to replay.

**Context preserved**: Resumed session correctly recalled "banana" from previous turn.

**Conclusion**: ~3s overhead per resume is noticeable but acceptable for hibernated sessions. Multi-turn via stdin has zero overhead (same process).

### 3. Memory Per Idle Process

**Claude Code process RSS**: ~306 MB

This is the Bun runtime + Claude Code CLI loaded in memory. Even idle (waiting for stdin), the process holds this.

**Implication**: 10 idle sessions = ~3 GB RAM. Auto-hibernate is essential.

### 4. Codex Multi-Turn

Codex supports session resumption in non-interactive mode:

```bash
codex exec resume <SESSION_ID> <PROMPT> --json
```

- Outputs JSONL events (like Claude Code's stream-json)
- Accepts session UUID or thread name
- Supports `--last` to resume most recent
- Also has `codex resume` for interactive TUI mode
- No stdin-based multi-turn (exec is single-prompt, single-process)

**Conclusion**: Both backends support continuation. Claude Code via stdin multi-turn + --resume. Codex via `exec resume`. The adapter abstraction can unify these.

## Status Model

### Current

```
queued → preparing → running → completed | failed | cancelled
```

Background: stdin.end() after first prompt → process exits → completed.
Interactive: stdin stays open → user sends via `orka send` → runs until `orka stop`.

### Proposed

```
                     ┌─────────────────────────────────┐
                     │                                  │
queued → preparing → running → idle ──→ hibernated     │
                     ↑          │         │             │
                     │          │         │             │
                     └──────────┘         │             │
                     (sendTurn on idle    │             │
                      writes to stdin)    │             │
                     ↑                    │             │
                     └────────────────────┘             │
                     (sendTurn on hibernated            │
                      spawns --resume process)          │
                     ↑                                  │
                     └──────────────────────────────────┘
                     (sendTurn on completed
                      spawns --resume process)

Terminal states: completed (user closes), failed (error)
```

### Status definitions

| Status | Process | Meaning |
|--------|---------|---------|
| `queued` | none | Waiting for concurrent slot |
| `preparing` | starting | Worktree being set up |
| `running` | alive, busy | Agent actively working on a turn |
| `idle` | alive, waiting | Turn complete, waiting for user input |
| `hibernated` | killed | Process killed (auto or manual), transcript saved, --resume possible |
| `completed` | none | User explicitly closed/merged the session |
| `failed` | none | Unrecoverable error |
| `cancelled` | none | User stopped before natural completion |

### Transitions

| From | To | Trigger |
|------|-----|---------|
| (new) | queued | spawn request |
| queued | preparing | slot available |
| preparing | running | process started, first prompt sent |
| running | idle | turn completes (result event received) |
| running | failed | process crashes / error event |
| running | cancelled | user stops (`orka stop`) |
| idle | running | sendTurn (write JSON to stdin) |
| idle | hibernated | idle timeout (configurable, default 10min) |
| idle | completed | user closes (`orka close`) |
| idle | cancelled | user stops (`orka stop`) |
| hibernated | running | sendTurn (spawn new process with --resume) |
| hibernated | completed | user closes (`orka close`) |
| completed | running | sendTurn (spawn new process with --resume) |

Note: `completed → running` is kept for backward compat with existing `continueSession`. The new flow prefers `idle → running` (zero overhead) or `hibernated → running` (~3s overhead).

### What "completed" means

In the current model, "completed" means "agent finished its work." In the unified model, it means "user is done with this session." The distinction matters:

- **Agent finishes a turn** → `idle` (not completed)
- **User says "we're done, merge this"** → `completed`
- **Auto-merge fires** → `completed` (auto-merge implies "done")
- **Prune removes the session** → `completed` (terminal)

## Architecture Changes

### Phase 1: Multi-turn for all sessions (remove mode)

**Remove `mode` field semantics.** All sessions behave like current interactive sessions:
- stdin stays open after initial prompt
- `sendTurn()` works on any running/idle session
- Process exits only when killed or on error

**Changes:**

1. **ClaudeCodeAdapter**: Never call `stdin.end()` after initial prompt. Already does this for interactive — just make it the default.

2. **OrchestrationEngine**: New status transitions. When `result` event received and process is still alive → set status to `idle` (not `completed`).

3. **SessionStatus enum**: Add `idle` and `hibernated`.

4. **SpawnRequest**: Remove `mode` field (or make it internal-only, always "interactive" under the hood).

5. **Dashboard**: All sessions show the chat input. No mode selector on spawn.

6. **`orka send`**: Works on `idle` sessions (same as current interactive). Error on `completed`/`hibernated` (use `orka continue` or transparent sendTurn).

7. **`orka wait`**: Returns when session transitions to `idle` (turn done). User can re-wait after sending another turn.

8. **`orka close <id>`** (new command): Explicitly marks session as `completed`. Kills process if alive. Equivalent to "I'm done iterating."

**What doesn't change:**
- Worktree management
- --auto-merge (fires on first idle transition, marks completed)
- Provider session ID tracking
- `orka merge`, `orka keep`, `orka diff`

### Phase 2: Auto-hibernate

After N minutes in `idle` state (configurable via `[limits] idle_timeout_minutes = "10"` in config.toml):

1. Kill the claude process (SIGTERM → SIGKILL)
2. Set status to `hibernated`
3. Broadcast `sessionUpdated` to dashboard
4. Dashboard shows hibernated indicator

On next `sendTurn` for a hibernated session:

1. Spawn new process with `--resume <providerSessionId>` (Claude Code) or `codex exec resume <id>` (Codex)
2. Write the new user message to stdin
3. Set status to `running`
4. Resume event consumption

The caller doesn't need to know about hibernation — `sendTurn` handles it transparently.

**Memory budget**: With 10-minute idle timeout, only actively-used sessions consume 306MB each. Hibernated sessions cost ~0 (just a DB row + saved transcript on disk).

### Phase 3: Dashboard UX

1. **Remove mode selector** from spawn dialog
2. **All sessions show chat input** — always visible below the timeline
3. **Status indicators**:
   - `running`: pulsing green dot
   - `idle`: steady blue dot, "Waiting for input..."
   - `hibernated`: gray dot with sleep icon, "Session paused — send a message to wake"
   - `completed`: checkmark
4. **"Close" button** — marks session completed, hides chat input
5. **Timeline**: Shows turn boundaries (visual separator between turns)

### Phase 4: Codex adapter parity

Implement `sendTurn` for Codex sessions:

- **Idle → running**: Not possible (codex exec is single-process-per-turn). Kill idle process, respawn with `codex exec resume <id> <prompt> --json`.
- **Hibernated → running**: `codex exec resume <id> <prompt> --json --dangerously-bypass-approvals-and-sandbox`
- Codex doesn't support stdin multi-turn, so every `sendTurn` on a Codex session is effectively a hibernate→resume cycle. This is fine — codex startup is fast and the API handles session replay.

## Migration from Current Model

### DB schema

```sql
-- New status values: 'idle', 'hibernated'
-- No schema change needed — status is TEXT, just add new values

-- mode column: keep for now, ignore in logic. Remove in future migration.
```

### Backward compatibility (none needed)

Per CLAUDE.md: "This project is NOT in production. Do not maintain backward compatibility."

Delete `mode` from `SpawnRequest`, `SessionModeSchema`, and all references. If callers pass `mode`, ignore it.

### CLI changes

| Current | New |
|---------|-----|
| `orka spawn --mode interactive` | `orka spawn` (all sessions are multi-turn) |
| `orka spawn --mode background` | `orka spawn` (same) |
| `orka send <id> <text>` | `orka send <id> <text>` (works on idle, transparent for hibernated) |
| `orka continue <id> <text>` | `orka send <id> <text>` (merged — send handles all states) |
| `orka stop <id>` | `orka stop <id>` (kills process, sets cancelled) |
| (none) | `orka close <id>` (marks completed, kills process) |

### RPC changes

| Current | New |
|---------|-----|
| `sendTurn(sessionId, text)` | `sendTurn(sessionId, text)` — handles idle, hibernated, and completed |
| `continueSession(params)` | Remove — merged into `sendTurn` |
| `spawn(req)` | `spawn(req)` — no `mode` field |
| (none) | `closeSession(sessionId)` — explicitly mark completed |

## What stays

- `--resume` mechanism (for hibernate/wake and completed→running)
- `provider_session_id` tracking
- Worktree management (unchanged)
- Event-sourced session reads
- `orka merge`, `orka keep`, `orka diff`, `orka result`
- Auto-merge (fires on first `idle` transition)

## What goes

- `mode: "background" | "interactive"` distinction
- `stdin.end()` after first prompt
- Different UI for bg vs interactive sessions
- Separate `continueSession` RPC (merged with `sendTurn`)
- Mode selector in dashboard spawn dialog

## Open Questions

1. **`orka wait` semantics**: Should `orka wait` return on `idle` (turn done) or block until `completed` (session closed)? Proposal: return on `idle`. The user script can then send more turns or close. Add `--until-completed` flag for "block until the session is fully done."

2. **Auto-merge timing**: Currently auto-merge fires on completion. In the new model, should it fire on first `idle` (turn done) or require `completed`? Proposal: fire on first `idle` — this preserves current behavior where background sessions complete after one turn and auto-merge kicks in.

3. **Hibernate vs close**: If a session has been hibernated for days, should it auto-close? Proposal: `orka prune --age 7d` already handles cleanup. Don't add another timeout.

4. **Cost tracking**: Each turn produces its own `result` event with cost. `orka result` already sums all `turn.completed` events. No change needed.

5. **Concurrent limits**: Does an `idle` session count against `max_concurrent`? Proposal: No — only `running` sessions count. Idle sessions are waiting for user input, not consuming API resources.
