# Worktree Lifecycle Hooks Design

## Goal

Add a host-side hooks system to orka so projects can prepare worktrees, react to session lifecycle events, and integrate local tooling without teaching orka about Bun, Python, Cargo, or any other stack.

## Non-goals

- No project-specific built-ins.
- No hook execution inside the agent sandbox.
- No long-running background hook daemons in v1.
- No automatic exposure of the user prompt to hooks.

## Design Summary

- Hooks are resolved from three layers: global config, project config, and CLI overrides.
- Hooks run on the daemon host, not inside the agent sandbox.
- Each lifecycle stage supports an ordered list of hooks.
- Hooks can be inline shell commands, script files, or script directories.
- Hooks receive context via environment variables plus a JSON context file path.
- Failure policy is configurable per hook: `abort`, `warn`, or `ignore`.
- All hook stdout/stderr is appended to the session log with explicit start/end markers.
- Project-local hooks are gated by a trust policy because they execute with full host access.

## Hook Stages

These stages map to the lifecycle that exists today in `spawnSession()`, `reapSessions()`, `merge()`, `stopSession()`, and worktree cleanup.

| Stage | When it runs | Blocking | Typical use |
| --- | --- | --- | --- |
| `session_preflight` | After session IDs/log file are allocated, before worktree creation or backend spawn | Yes | Validate local prerequisites, export secrets from a local store, reject unsupported machines |
| `post_worktree_create` | Immediately after git worktree creation or branch checkout succeeds, before agent launch | Yes | Install deps, create venv, warm caches, generate local config |
| `pre_agent_start` | After setup hooks, right before tmux/backend spawn | Yes | Final sanity checks, write marker files, emit notifications |
| `post_agent_start` | After tmux/backend spawn succeeds and session becomes `running` | No by default | Notify external tools, start local observers |
| `post_agent_exit` | After agent exit is detected and exit code/session status are known | No by default | Collect artifacts, summarize logs, notify users |
| `pre_merge` | Before auto-merge or manual `orka merge` begins | Yes | Run repo-local checks that must pass before merge |
| `post_merge` | After merge succeeds, before cleanup | No by default | Notify CI, update local bookkeeping |
| `merge_failed` | After merge attempt fails and the worktree is preserved | No | Notify user, collect conflict context |
| `pre_cleanup` | Before worktree/branch removal | Yes | Archive artifacts, snapshot logs |
| `post_cleanup` | After worktree/branch removal succeeds | No | Notify completion, prune local state |
| `cleanup_skipped` | When orka intentionally preserves a worktree (`kept`, dirty tree, commits ahead) | No | Explain why the worktree remains |
| `cleanup_failed` | When cleanup was attempted but removal/delete failed | No | Alert and capture diagnostics |

### Why not more stages?

- `post_worktree_create` is the main setup stage the product needs.
- `post_worktree_create` is skipped when a session runs directly in the project root without creating a worktree.
- `session_preflight` exists so users can fail early before any git mutation.
- `post_agent_exit` is enough for both success and failure because hooks receive `ORKA_SESSION_STATUS` and `ORKA_EXIT_CODE`.
- Orphan-prune hooks are out of scope for v1 because they are not session-scoped and do not have a natural session log.

## Hook Specification

The stage value is a table with metadata plus an ordered `items` array. Each item is one hook.

```toml
[hooks]
enabled = true
default_shell = "/usr/bin/env bash"
default_timeout = "10m"
project_hooks = "trusted-only" # disabled | trusted-only | always

[hooks.post_worktree_create]
strategy = "append" # append | replace
disable = []        # optional list of inherited hook ids

[[hooks.post_worktree_create.items]]
id = "deps"
run = "bun install --frozen-lockfile"
cwd = "worktree"    # project | worktree | explicit path
on_failure = "abort"
timeout = "20m"
backends = ["claude-code", "codex"]
modes = ["background", "interactive"]
when = "test -f package.json && test -f bun.lock"

[[hooks.post_worktree_create.items]]
id = "seed-env"
script = ".orka/hooks/seed-env.sh"
cwd = "worktree"
on_failure = "warn"

[[hooks.post_worktree_create.items]]
id = "local-bootstrap"
directory = ".orka/hooks/post-worktree-create.d"
cwd = "worktree"
on_failure = "warn"
```

### Supported hook forms

- `run = "cmd"`: shell command executed as `bash -lc`.
- `run = '''...'''`: multiline inline shell script.
- `script = "path/to/script.sh"`: run one script file.
- `directory = "path/to/dir"`: run each executable file in lexical order.

`script` and `directory` paths are resolved relative to the config file that declared them.

### Why support all three?

- Inline `run` is the fastest path for simple commands.
- `script` keeps complex logic in versioned files.
- `directory` matches the usability of `.git/hooks` and lets teams split large setup flows into small steps.

### Execution model

- Hooks run serially, never in parallel, for deterministic logs and failure handling.
- Within a `directory`, executable entries run in lexical order.
- A stage stops at the first hook whose `on_failure = "abort"` exits non-zero.
- v1 does not support `async = true`; post-start/post-exit hooks still run on the host, but synchronously.

## Configuration Layers and Ordering

### Sources

1. Global: `~/.orka/config.toml`
2. Project: `<repo>/.orka.toml`
3. CLI: ephemeral highest-precedence overrides

### Resolution rules

For each stage:

1. Start with the global stage config.
2. Merge the project stage config.
3. Merge the CLI stage config.

Default merge behavior is `strategy = "append"`:

- inherited hooks stay in place
- higher-precedence hooks are appended after lower-precedence hooks
- `disable = ["id"]` removes inherited hooks by id before append

`strategy = "replace"` discards all lower-precedence hooks for that stage.

### Recommended ordering

- Global first: machine-wide bootstrap, credential helpers, generic tooling
- Project second: repo-specific setup
- CLI last: one-off experimentation or temporary overrides

This preserves predictable layering while keeping local ad hoc overrides possible.

## CLI Override Design

Add these flags to `spawn`, `merge`, and `prune`-style lifecycle commands that may trigger hooks:

- `--hook-config <path>`: load an extra TOML file as the highest-precedence source
- `--hook <stage>:<command>`: append one inline hook to a stage
- `--disable-hook <id>`: disable inherited hook ids
- `--no-hooks`: disable all hook execution for this command

CLI overrides are converted into a synthetic config source named `cli`.

## Backend and Mode Filtering

Per-backend and per-mode behavior is handled by selectors on each hook item, not by creating separate config trees.

Supported selectors:

- `backends = ["codex"]`
- `modes = ["background"]`
- `when = "shell expression"` for repo/tool detection

This is simpler than `[hooks.codex.background.post_worktree_create]` and still handles backend-specific behavior cleanly.

## Trust Model for Project Hooks

Project hooks are powerful because they execute outside the sandbox with full host access. A repo-local `.orka.toml` therefore must be treated as executable code.

Default policy:

- `project_hooks = "trusted-only"`
- global config may list trusted project roots
- CLI may temporarily allow hooks for the current invocation

Proposed global config:

```toml
[hooks]
project_hooks = "trusted-only"

[trust]
projects = [
  "/home/me/src/orka",
  "/home/me/src/payments",
]
```

Behavior:

- `disabled`: ignore `.orka.toml` completely
- `trusted-only`: load `.orka.toml` only if the repo root is trusted
- `always`: always load `.orka.toml`

This keeps the feature usable for owned repos without silently granting host execution to arbitrary clones.

## Environment Variables

Hooks inherit the daemon environment and receive additional `ORKA_*` variables.

| Variable | Example | Notes |
| --- | --- | --- |
| `ORKA_HOOK_ID` | `deps` | Stable hook identifier |
| `ORKA_HOOK_STAGE` | `post_worktree_create` | Current lifecycle stage |
| `ORKA_HOOK_SOURCE` | `global`, `project`, `cli` | Config source that declared the hook |
| `ORKA_HOOK_CONTEXT_FILE` | `/tmp/orka-hook-ctx-123.json` | Path to full JSON payload for structured consumers |
| `ORKA_COMMAND` | `spawn`, `merge`, `stop`, `prune` | Invoking orka command |
| `ORKA_SESSION_ID` | `sess-ab12cd34` | Present for session-scoped stages |
| `ORKA_TASK_ID` | `task-ef56ab78` | Present for spawned sessions |
| `ORKA_WORKSPACE_ID` | `ws-1234abcd` | Workspace identifier |
| `ORKA_PROJECT_PATH` | `/src/myapp` | Repository root |
| `ORKA_WORKING_DIR` | `/home/me/.orka/worktrees/sess-ab12cd34` | Directory where the agent runs |
| `ORKA_WORKTREE_PATH` | `/home/me/.orka/worktrees/sess-ab12cd34` | Empty when no worktree exists |
| `ORKA_BACKEND` | `codex` | Backend kind |
| `ORKA_MODE` | `background` | Session mode |
| `ORKA_MODEL` | `gpt-5-codex` | Empty if unset |
| `ORKA_TMUX_SESSION` | `orka-sess-ab12cd34` | Empty before tmux exists |
| `ORKA_LOG_FILE` | `~/.orka/logs/sess-ab12cd34.log` | Session log path |
| `ORKA_AUTO_MERGE` | `1` | `1` or `0` |
| `ORKA_SESSION_STATUS` | `running`, `completed`, `failed`, `cancelled` | Especially useful in `post_agent_exit` |
| `ORKA_EXIT_CODE` | `0` | Empty until known |
| `ORKA_BRANCH` | `orka/sess-ab12cd34` | Worktree branch |
| `ORKA_PARENT_BRANCH` | `main` | Merge target branch |
| `ORKA_CLEANUP_REASON` | `manual-merge`, `auto-merge`, `stop`, `prune` | Present for cleanup stages |
| `ORKA_CLEANUP_SKIP_REASON` | `kept`, `uncommitted_changes`, `commits_ahead` | Present only for `cleanup_skipped` |

### JSON context file

`ORKA_HOOK_CONTEXT_FILE` points at a temporary JSON document with the same fields plus structured extras:

- timestamps
- config file path
- merge metadata
- cleanup metadata
- trusted-project decision

This avoids overloading environment variables while keeping the required env-based contract.

### Deliberately excluded from env

- session prompt
- API tokens
- approval state

Prompt text should stay out of env/process tables by default. If prompt exposure is ever needed, it should be an explicit opt-in later.

## Error Handling

Each hook declares `on_failure`:

- `abort`: stop the current lifecycle operation and surface the failure
- `warn`: log the failure, emit a warning, continue
- `ignore`: log at debug level only, continue

### Recommended defaults by stage

- Blocking stages default to `abort`: `session_preflight`, `post_worktree_create`, `pre_agent_start`, `pre_merge`, `pre_cleanup`
- Notification/reporting stages default to `warn`: `post_agent_start`, `post_agent_exit`, `post_merge`, `merge_failed`, `post_cleanup`, `cleanup_skipped`, `cleanup_failed`

`abort` is only valid on blocking stages. Config validation should reject `on_failure = "abort"` for non-blocking stages.

### User-visible behavior

If a blocking hook fails:

- the stage name, hook id, exit code, and config source are shown to the user
- the failure is appended to the session log
- the span `orka.hook.run` records the exception and attributes
- spawn-related failures leave the session in `failed` if a session record already exists
- if spawn already created a worktree, the worktree is preserved for inspection rather than auto-deleted
- merge-related failures leave the worktree untouched

### Log format

Each hook writes clear markers into the session log:

```text
[orka][hook][post_worktree_create][deps] start source=project cwd=/.../sess-ab12cd34
... hook stdout/stderr ...
[orka][hook][post_worktree_create][deps] exit_code=0 duration_ms=18234
```

This keeps `orka logs`, result parsing, and future diagnostics compatible with existing log handling.

## TOML Examples

### JavaScript / Bun

```toml
[hooks]
project_hooks = "trusted-only"

[hooks.post_worktree_create]
strategy = "append"

[[hooks.post_worktree_create.items]]
id = "bun-install"
run = "bun install --frozen-lockfile"
cwd = "worktree"
on_failure = "abort"
when = "test -f package.json && test -f bun.lock"

[[hooks.post_worktree_create.items]]
id = "typecheck"
run = "bun run typecheck"
cwd = "worktree"
on_failure = "warn"
backends = ["codex"]
```

### Python / uv

```toml
[hooks.post_worktree_create]

[[hooks.post_worktree_create.items]]
id = "uv-sync"
run = "uv sync --frozen"
cwd = "worktree"
on_failure = "abort"
when = "test -f pyproject.toml && test -f uv.lock"

[[hooks.post_worktree_create.items]]
id = "activate-marker"
run = '''
  test -d .venv
  printf '%s\n' '.venv ready' > .orka-bootstrap
'''
cwd = "worktree"
on_failure = "warn"
```

### Rust / Cargo

```toml
[hooks.post_worktree_create]

[[hooks.post_worktree_create.items]]
id = "cargo-fetch"
run = "cargo fetch --locked"
cwd = "worktree"
on_failure = "abort"
when = "test -f Cargo.toml && test -f Cargo.lock"

[[hooks.post_worktree_create.items]]
id = "cargo-build"
run = "cargo build --workspace --locked"
cwd = "worktree"
on_failure = "warn"
modes = ["background"]
```

## Existing Art

- Git hooks: event-named executable entry points and script directories are a good mental model. Orka borrows stage naming and directory execution, but adds ordered multi-hook lists and config layering instead of one file per event.
- npm scripts: inline shell commands and `pre`/`post` naming are ergonomic. Orka borrows inline command support, but keeps hooks independent of any package manager.
- GitHub Actions: `on:` plus filters (`types`, branches, paths) shows the value of event names with per-handler selectors. Orka borrows the selector idea via `backends`, `modes`, and `when`.
- Docker: separate lifecycle concepts such as `ENTRYPOINT`, `CMD`, and `HEALTHCHECK` reinforce that startup, steady-state, and health events should not be conflated. Orka keeps setup hooks distinct from exit/cleanup hooks for the same reason.
- Claude Code hooks: typed lifecycle events, multiple config layers, and structured matching are the closest analogue. Orka should borrow typed events and layered resolution, but keep hooks tied to daemon/session lifecycle rather than tool invocations.

Reference docs:

- Git hooks: https://git-scm.com/docs/githooks
- npm scripts: https://docs.npmjs.com/cli/v11/using-npm/scripts
- GitHub Actions events: https://docs.github.com/en/actions/reference/events-that-trigger-workflows
- Dockerfile reference: https://docs.docker.com/reference/dockerfile/
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks

## Implementation Plan

### 1. Config and schema

- Replace the minimal parser in [packages/daemon/src/config.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/daemon/src/config.ts) with a TOML parser that can handle arrays-of-tables and nested sections.
- Extend config loading to resolve and merge:
  - `~/.orka/config.toml`
  - trusted project `.orka.toml`
  - CLI synthetic hook config
- Add zod schemas for hook stages, hook items, trust policy, and merge strategy.

### 2. Hook runner

- Add a new daemon module such as `packages/daemon/src/hooks.ts`.
- Responsibilities:
  - resolve effective hooks for a stage
  - build env/context payload
  - execute `run`, `script`, and `directory` hooks
  - stream stdout/stderr into the session log
  - emit spans like `orka.hook.resolve` and `orka.hook.run`

### 3. Lifecycle integration

- Update [packages/daemon/src/orchestrator.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/daemon/src/orchestrator.ts) to:
  - create the session log before the first hook
  - run spawn hooks around worktree creation and backend start
  - run exit hooks during reap/stop
  - run merge and cleanup hooks around auto-merge and cleanup paths
- Update [packages/daemon/src/local-client.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/daemon/src/local-client.ts) so manual `merge()` also goes through the same hook orchestration path.

### 4. CLI and RPC plumbing

- Extend [packages/core/src/types.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/core/src/types.ts) and [packages/core/src/service.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/core/src/service.ts) with hook override inputs where needed.
- Add CLI flags in [packages/cli/src/index.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/cli/src/index.ts): `--hook-config`, `--hook`, `--disable-hook`, `--no-hooks`.
- Ensure the remote path continues to work through [packages/daemon/src/remote-client.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/daemon/src/remote-client.ts) and [packages/daemon/src/rpc-handler.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/daemon/src/rpc-handler.ts).

### 5. Project trust plumbing

- Extend [packages/daemon/src/projects.ts](/home/ilyagulya/.orka/worktrees/sess-f213570b/packages/daemon/src/projects.ts) or adjacent config state to track trusted project roots.
- Add CLI affordances later if needed, for example `orka project trust <path>`.

### 6. Tests

- Add config merge tests in `packages/daemon/src/config.test.ts`.
- Add hook resolution and failure-policy tests in a new `packages/daemon/src/hooks.test.ts`.
- Add orchestrator integration tests covering:
  - successful `post_worktree_create`
  - aborting setup hook
  - post-exit hook logging
  - merge hook abort preserving the worktree
  - cleanup skip/fail stages

## Recommended v1 scope

Implement these first:

1. `session_preflight`
2. `post_worktree_create`
3. `pre_agent_start`
4. `post_agent_exit`
5. `pre_merge`
6. `post_merge`
7. `pre_cleanup`
8. `post_cleanup`

That delivers the core setup and teardown value without overbuilding notification-only stages on day one.
