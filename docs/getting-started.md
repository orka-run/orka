# Getting Started

This guide uses `orka` in examples. From the repo root, that means either:

- `./orka ...`
- or `bun run packages/cli/src/index.ts ...`

## Installation

Prerequisites:

- Bun
- Git
- At least one agent CLI:
  - Claude Code: `npm install -g @anthropic-ai/claude-code`
  - Codex: `bun install -g @openai/codex`
  - Shell backend: no extra install

Set up the repo:

```bash
bun install
```

If `node-pty` fails to build, the default runtime path still works. `node-pty` is only needed for the legacy fallback when `providers.use_runtime = false`.

Optional: expose the wrapper on your `PATH`.

```bash
chmod +x ./orka
ln -sf "$PWD/orka" ~/.local/bin/orka
```

## Quick Start

Start a background session in an isolated worktree:

```bash
orka spawn -m background --backend codex --title "Fix auth retry bug" \
  "Find the auth retry bug, add a regression test, and commit the fix"
```

Watch it live:

```bash
orka ps --status running -v
orka attach sess-abc123
```

Wait for completion and inspect the result:

```bash
orka wait sess-abc123
orka result sess-abc123
orka diff sess-abc123
```

Merge the worktree back into your current branch:

```bash
orka merge sess-abc123
```

For one-shot runs that should merge automatically on success:

```bash
orka spawn -m background --auto-merge "Update the release notes and commit the change"
```

## CLI Commands

| Command | What it does | Example |
| --- | --- | --- |
| `spawn` | Start a new agent session | `orka spawn -m background -b claude-code "Add caching to the API client"` |
| `ps` | List sessions, with filters | `orka ps --status running --backend codex -v` |
| `attach` | Stream live output from a running session | `orka attach sess-abc123` |
| `logs` | Show logs once or follow them | `orka logs -f sess-abc123` |
| `stop` | Stop a running or preparing session | `orka stop sess-abc123` |
| `diff` | Show uncommitted and committed changes in a session worktree | `orka diff sess-abc123` |
| `show` | Show session metadata, prompt, tags, and paths | `orka show sess-abc123` |
| `merge` | Merge a session branch into the current branch | `orka merge sess-abc123` |
| `retry` | Re-run a finished session with the same prompt and options | `orka retry sess-abc123` |
| `wait` | Block until one or more sessions finish | `orka wait --all --project myapp` |
| `result` | Show final result text, cost, and tokens | `orka result --json sess-abc123` |
| `send` | Send text to a running interactive session | `orka send sess-abc123 "continue with the failing tests"` |
| `keep` | Protect a worktree from cleanup | `orka keep sess-abc123` |
| `unkeep` | Remove cleanup protection | `orka unkeep sess-abc123` |
| `prune` | Remove old finished sessions and orphaned worktrees | `orka prune --age 7d --confirm` |
| `workdir` | Print the session working directory | `cd "$(orka workdir sess-abc123)"` |
| `project` | Add/list/remove project aliases | `orka project add myapp ~/src/myapp` |
| `serve` | Run the daemon server | `orka serve --port 7394` |
| `relay` | Run the relay router for multi-machine setups | `orka relay --port 7390 --token mysecret` |
| `keygen` | Manage E2E encryption keys | `orka keygen client` |

Useful `spawn` options:

- `--project` project path or alias
- `--backend` `claude-code|codex`
- `--mode` `interactive|background`
- `--model` backend model name
- `--branch` use or create a specific branch for the worktree
- `--title` label shown in `orka ps`
- `--prompt-file` read prompt text from a file
- `--tag` attach repeatable tags
- `--auto-merge` merge automatically on success
- `--system-prompt` prepend extra instructions
- `--allowed-tools` comma-separated Claude Code tools
- `--env KEY=VALUE` pass repeatable environment variables
- `--reasoning-effort low|medium|high` for Codex

Global remote options:

- `--remote ws://host:7394` connect to a remote daemon or relay
- `--token ...` auth token for relay or daemon
- `--encrypt` enable E2E encryption
- `--server-key ...` provide the server public key for E2E

## Configuration

User config lives at `~/.orka/config.toml`.

Full example:

```toml
[defaults]
backend = "claude-code"
mode = "interactive"
model = ""
project = "."

[limits]
max_concurrent = 3

[providers]
use_runtime = true

[hooks]
post_worktree_create = "bun install"
```

Sections:

- `[defaults]`
  - `backend` default backend for `spawn`
  - `mode` default session mode
  - `model` default model string
  - `project` default project path or alias
- `[limits]`
  - `max_concurrent` maximum concurrent sessions
  - `0` means unlimited
- `[providers]`
  - `use_runtime = true` uses the provider runtime
  - `false` switches to the legacy compatibility path
- `[hooks]`
  - `post_worktree_create` runs after a worktree is created
  - Commands run in the new worktree directory
  - Hook failures warn but do not abort the session

`post_worktree_create` accepts all three TOML forms:

```toml
[hooks]
post_worktree_create = "bun install"
```

```toml
[hooks]
post_worktree_create = ["bun install", "bun test packages/core"]
```

```toml
[hooks]
post_worktree_create = [
  { run = "bun install" },
  { run = "git status --short" },
]
```

## Dashboard

### Dev mode

Run the daemon, then start the dashboard dev server:

```bash
orka serve
cd packages/dashboard && bun run dev
```

Open `http://localhost:3773`. Vite proxies `/ws` to `ws://localhost:7394`.

### Docker

```bash
docker compose up
```

This starts both daemon and dashboard. The dashboard is available at `http://localhost:3773`.

### What it shows

- Session sidebar grouped by running, completed, and failed
- Live session selection and stop controls
- Overview panel with metadata, timing, usage, and result data
- Chat, logs, and diff tabs for the selected session
- New-session dialog for launching sessions from the browser

## Multi-Machine Mode

Start a central relay:

```bash
orka relay --port 7390 --token mysecret
```

Start a daemon node and register it with the relay:

```bash
orka serve --port 7394 --relay ws://relay-host:7390 --node-id node1 --relay-token mysecret
```

Enable E2E encryption:

```bash
orka keygen client
orka keygen save-server "$(curl -s http://daemon-host:7394/health | jq -r .publicKey)"
```

Connect through the relay:

```bash
orka --remote ws://relay-host:7390/ws --token mysecret --encrypt ps
orka --remote ws://relay-host:7390/ws --token mysecret --encrypt spawn -m background "Run the test suite and summarize failures"
```

How it works:

- clients talk to the relay over WebSocket JSON-RPC
- relay forwards requests to registered daemon nodes
- only routing metadata stays in plaintext
- request params and results can be encrypted end to end

Useful env vars:

```bash
export ORKA_REMOTE=ws://relay-host:7390/ws
export ORKA_TOKEN=mysecret
export ORKA_ENCRYPT=1
```

## Tips

- Use tags to group batches of work: `orka spawn -m background --tag migration --tag api "..."`
- Wait on groups of work instead of polling: `orka wait --all` or `orka wait --all --project myapp`
- Use project aliases to shorten commands: `orka project add myapp ~/src/myapp`
- Inspect before merge: `orka show`, `orka result`, and `orka diff` cover most review flow
- Use `orka keep` before cleanup if you want to preserve a worktree for manual follow-up
- For automatic landing, combine `-m background` with `--auto-merge`
- Use `orka workdir <id>` when you want to open the exact worktree in your editor or shell
