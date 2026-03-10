# Orka — Agent Session Orchestrator

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
  core/     — @orka/core: domain types (Session, Task, SpawnRequest, etc.)
  daemon/   — @orka/daemon: tmux runtime, git worktree, SQLite storage, backends, orchestrator
  cli/      — @orka/cli: CLI entry point (spawn, ps, attach, logs, stop, diff)
orka        — shell wrapper for global CLI access
```

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Storage**: SQLite via bun:sqlite (~/.orka/orka.db)
- **Session runtime**: tmux (sessions prefixed `orka-`)
- **Logs**: ~/.orka/logs/<session-id>.log
- **Issue tracking**: beads (`bd` CLI)

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
