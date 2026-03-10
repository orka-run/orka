# Orka — Agent Session Orchestrator

See also: [AGENTS.md](./AGENTS.md) for issue tracking and agent workflow conventions.

## Commit Policy

**MANDATORY: After completing each task/issue, create a git commit BEFORE moving to the next task.**

- One task = one commit (minimum)
- Commit message format: `<type>: <what changed>` (e.g. `feat: add orka diff command`, `fix: tmux spawn shell escaping`)
- Stage only relevant files, never `.orka/`, `node_modules/`, `*.db`
- If a beads issue is closed, the corresponding code MUST be committed
- Do NOT batch multiple unrelated tasks into one commit

## Project Structure

```
packages/
  core/     — @orka/core: domain types, zod schemas (Session, Task, BackendKind, etc.)
  daemon/   — @orka/daemon: orchestrator, tmux, git worktree, SQLite, backends, config
  cli/      — @orka/cli: CLI entry point (13 commands)
orka        — shell wrapper for global CLI access
```

## CLI Commands

```
spawn   — Spawn an agent session (--backend, --mode, --model, --branch, --title)
ps      — List sessions (--status, --backend filters)
attach  — Attach to running tmux session
logs    — View session output (--follow/-f for live streaming)
stop    — Stop a running session
diff    — Show git changes in session worktree
show    — Full session detail view (status, project, model, prompt, etc.)
workdir — Print session working directory (for shell: cd $(orka workdir <id>))
wait    — Block until session(s) complete (supports --all)
retry   — Re-run a session with same prompt/model/title
prune   — Remove old completed sessions (--age, also cleans orphaned worktrees)
```

## Import Policy

- **Between packages**: use workspace aliases — `import { ... } from "@orka/core"`, `import { ... } from "@orka/daemon"`
- **Within a package**: use relative imports **without file extensions** — `import { ... } from "./db"`, NOT `"./db.js"` or `"./db.ts"`
- Bun resolves `.ts` files from extensionless imports automatically
- Never use `@/` prefix — it doesn't work in Bun monorepo context

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Validation**: zod — enum schemas in core/types.ts, config validation, DB row parsing
- **Storage**: SQLite via bun:sqlite (~/.orka/orka.db), versioned migrations in db.ts
- **Session runtime**: tmux (sessions prefixed `orka-`)
- **Worktrees**: ~/.orka/worktrees/<session-id> (OUTSIDE main repo for isolation)
- **Logs**: ~/.orka/logs/<session-id>.log
- **Scripts**: ~/.orka/scripts/<session-id>.sh (command written to file, not inline bash -c)
- **Config**: ~/.orka/config.toml (optional, TOML with [defaults] and [limits] sections)
- **Issue tracking**: beads (`bd` CLI)

## Key Architecture Decisions

- **Worktrees outside main repo**: Background sessions get worktrees at `~/.orka/worktrees/` so `git rev-parse --show-toplevel` returns the worktree path, not the parent repo. This prevents agents from accidentally editing the main repo.
- **Script files for tmux**: Commands are written to `~/.orka/scripts/<id>.sh` and tmux runs `bash <path>` — avoids nested `bash -c` shell escaping issues.
- **Session stores projectPath**: The original repo root is stored in the session record, separate from workingDir (which may be a worktree). Used for retry and worktree cleanup.
- **Auto-reap on every CLI invocation**: `reapSessions()` runs before every command, marking dead tmux sessions as completed and cleaning up worktrees.
- **Concurrent limits**: Configurable via `[limits] max_concurrent = "5"` in config.toml (0 = unlimited).

## Development Commands

```bash
# Run CLI directly
bun run packages/cli/src/index.ts <command>

# Or via wrapper (if symlinked to ~/.local/bin/orka)
orka <command>

# Check issues
bd ready
bd list --status=open
```

## Agent Sessions (orka-spawned claude-code)

- Background sessions use: `claude -p --verbose --output-format stream-json --permission-mode auto`
- Interactive sessions use: `claude <prompt>`
- All sessions get `--append-system-prompt "[orka session: <id>]"` for traceability
- Logs are tee'd to ~/.orka/logs/ for post-mortem reading
- Background sessions automatically get isolated worktrees at ~/.orka/worktrees/
