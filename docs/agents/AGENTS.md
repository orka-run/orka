# Agent Instructions

This project uses **br** (beads) for issue tracking. Run `br capabilities --format json` and `br ready --json` to get started.

## Spawning Agent Sessions

The default session mode is **background** — the agent completes after one turn and exits. Only use `--mode interactive` when you explicitly need multi-turn conversations via `orka send`.

```bash
# Default (background) — agent completes on its own
orka spawn --backend claude-code --branch orka/my-feature --title "do the thing" --prompt-file task.md

# Interactive — only for multi-turn sessions (use orka send to follow up)
orka spawn -m interactive --backend claude-code --title "chat session" "hello"
```

## Backend Selection by Task Type

- **Frontend / frontend-design tasks** (dashboard, UI components, styling): use **claude-code** with model **claude-opus-4-6**
- **Backend / tooling tasks** (daemon, CLI, config, infra): any backend (codex or claude-code)

## Quick Reference

```bash
br ready              # Find available work
br show <id>          # View issue details
br update <id> --claim  # Claim work atomically
br close <id>         # Complete work
br sync --flush-only  # Export SQLite state to JSONL
```

## Architecture Snapshot

- Orka is daemon-first now: normal CLI commands talk to the daemon over WebSocket RPC through `RemoteClient`.
- The CLI no longer opens SQLite directly and no longer uses `LocalClient` outside `orka serve`.
- If the local daemon is not running, the CLI auto-starts it with `setsid bun run <cli-path> serve`.
- Daemon state lives under `~/.orka/`, including `daemon.pid`, `logs/daemon.log`, `orka.db`, session logs, and worktrees.
- `providers.use_runtime` defaults to `true`, so the provider adapter runtime is the primary execution path.
- tmux still exists only as a compatibility path when `providers.use_runtime = false`.
- `orka attach` now streams live session output; it no longer attaches to tmux.
- The dashboard connects through same-origin `/ws` in both Vite dev and nginx prod, not directly to the daemon port.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Observability Policy

**All significant operations MUST be covered by OpenTelemetry spans.** This is a first-class requirement, not an afterthought.

### What must be traced

- **Every CLI command** — wrap handler in `withSpan("orka.cli.<command>", ...)`
- **Every orchestrator operation** — spawn, reap, stop, cleanup (already done)
- **Every worktree operation** — create, remove, merge, diff, hasChanges, hasCommitsAhead
- **Every relay routing hop** — client→relay, relay→node, node→relay, relay→client
- **Every auth/rate-limit decision** — authenticate(), check(), checkMessage()
- **Every DB write** — insert/update operations (reads only if slow-query debugging needed)
- **Every remote RPC call** — WS JSON-RPC request/response in RemoteClient

### Span naming convention

```
orka.cli.spawn          — CLI command spans
orka.spawn              — orchestrator/daemon spans
orka.worktree.create    — worktree operation spans
orka.relay.forward      — relay routing spans
orka.relay.auth         — relay auth spans
orka.db.insertSession   — database operation spans
orka.rpc.request        — remote client spans
```

### Attributes

Every span should include relevant context:
- `orka.session.id` — on any session-related operation
- `orka.account.id` — on any account-scoped relay operation
- `orka.command` — on CLI commands
- `orka.method` — on RPC calls
- Error spans must include exception details via `span.recordException(err)`

### How to add a span

```typescript
import { withSpan } from "./tracing";

const result = await withSpan("orka.something", {
  "orka.session.id": sessionId,
  "orka.key": value,
}, async (span) => {
  // ... do work ...
  span.addEvent("something.happened", { detail: "value" });
  return result;
});
```

### Trace output

- **Daemon**: `~/.orka/traces.jsonl` (always on)
- **Relay**: `~/.orka-relay/traces.jsonl` (always on)
- **Console**: `ORKA_TRACE=console` env var
- **OTLP**: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with br (beads)

**IMPORTANT**: This project uses **br (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why br?

- Dependency-aware: Track blockers and relationships between issues
- Local-first: SQLite database with tracked JSONL handoff
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
br ready --json
```

**Create new issues:**

```bash
br create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
br create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:orka-123 --json
```

**Claim and update:**

```bash
br update <id> --claim --json
br update <id> --priority 1 --json
```

**Complete work:**

```bash
br close <id> --reason "Completed: <proof>" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `br ready` shows unblocked issues
2. **Claim your task atomically**: `br update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `br create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `br close <id> --reason "Done"`

### Auto-Sync

br keeps local SQLite state and exports a git-friendly JSONL file:

- Exports to `.beads/issues.jsonl` with `br sync --flush-only`
- Imports from JSONL with `br sync --import-only` (e.g., after `git pull`)
- Run the explicit sync commands when handing changes to git or another clone.

### Important Rules

- ✅ Use br for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `br ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   br sync --flush-only
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
