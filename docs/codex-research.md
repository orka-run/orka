# OpenAI Codex CLI — Architecture Research

> Research date: 2026-03-11
> Source: https://github.com/openai/codex (cloned to /tmp/codex-research)

## Project Structure

Two implementations — legacy TypeScript CLI (`codex-cli/`) and current **Rust rewrite** (`codex-rs/`) with 75+ crates:

```
codex-rs/
  core/           — Agent loop, exec engine, sandboxing, config (279KB codex.rs alone)
  exec/           — Headless non-interactive CLI ("codex exec PROMPT")
  tui/            — Full-screen interactive TUI (Ratatui-based)
  cli/            — Multi-tool entry point (dispatches to tui/exec/sandbox/apply)
  app-server/     — HTTP/WS JSON-RPC server for IDE integration
  linux-sandbox/  — Bubblewrap + Landlock + Seccomp
  windows-sandbox-rs/ — Windows restricted tokens + ACL
  apply-patch/    — Pure Rust fast file editor (tree-sitter aware)
  utils/git/      — Git operations via CLI (no libgit2)
  state/          — SQLite session persistence
  config/         — TOML config with validation
  protocol/       — Core types (models, permissions, sandbox policies)
  mcp-server/     — Model Context Protocol server
  execpolicy/     — Rule-based command policy checker
```

---

## Why It's Fast

### Rust everywhere that matters

The entire execution pipeline — sandbox setup, process spawning, output streaming, file patching — is native Rust compiled to a single binary. No Node.js overhead for hot paths. LTO enabled in release, single codegen unit, symbol stripping.

### In-process app-server (zero IPC overhead)

`codex exec` runs the app-server as an async Tokio task **in the same process**, communicating via bounded channels (128 messages). No subprocess spawn, no pipe serialization, sub-millisecond internal communication.

```
codex-exec binary
  ↓ InProcessAppServerClient (async task, not subprocess)
  ↓ bounded channel (128 messages)
app-server logic (same process)
  ↓
core::codex agent loop
```

### Streaming event architecture

Output is chunked in **8KB reads**, emitted as delta events (max 10K per exec call). The CLI shows live progress without buffering full results. Output capped at **8MB** to prevent OOM.

Key constants:
- `READ_CHUNK_SIZE`: 8KB
- `EXEC_OUTPUT_MAX_BYTES`: 8MB
- Max 10,000 delta events per exec call
- `IO_DRAIN_TIMEOUT_MS`: 2s (wait for grandchildren to exit)

### Pure Rust apply-patch

File edits use the `similar` crate (Rust diff algorithm) + tree-sitter for syntax-aware patching. Sub-millisecond latency, no external binary calls. Custom patch format:

```
*** Begin Patch
*** Update File: path/to/file.txt
@@ ... @@
- old line
+ new line
*** End Patch
```

### Parallel tool execution

`ToolCallRuntime` in `core/src/tools/parallel.rs` processes multiple tool invocations concurrently via `FuturesOrdered`. Response aggregation happens before the next agent turn.

### Timeout safety without overhead

```rust
enum ExecExpiration {
    Timeout(Duration),              // custom per-command
    DefaultTimeout,                 // 10s
    Cancellation(CancellationToken), // agent-driven
}
```

IO drain timeout (2s) prevents zombie grandchildren from blocking the pipeline. Git commands have separate 5s timeout.

---

## Sandbox Model

### Linux (most sophisticated)

**Two-stage pipeline:**

**Stage 1 — Bubblewrap (filesystem isolation):**
- Read-only root filesystem (`--ro-bind / /`)
- Writable roots whitelisted via `--bind`
- Protected paths (`.git`, `.codex`) re-applied as read-only inside writable roots
- Namespace isolation: user, PID, optionally network
- `--new-session`, `--die-with-parent`, fresh `/proc` mounting
- Smart fallback when `--proc /proc` denied in containers

**Stage 2 — Seccomp BPF (syscall filtering):**
- Blocks: `connect`, `bind`, `listen`, `accept*`, `ptrace`, `io_uring_*`
- Restricted mode: blocks `socket` except AF_UNIX
- Proxy-routed mode: allows AF_INET/AF_INET6 for managed TCP bridge, blocks AF_UNIX
- `PR_SET_NO_NEW_PRIVS` enabled
- Targets x86_64 and aarch64

**Managed proxy mode:**
- Isolated netns with local TCP→UDS→TCP bridge
- Allows controlled network access through relay
- After bridge is live, seccomp blocks new AF_UNIX/socketpair

**Fallback chain:** bubblewrap → landlock → none (graceful degradation)

### macOS

Apple Seatbelt (`sandbox-exec`) with custom profiles. Read-only jail except `$PWD`, `$TMPDIR`, `~/.codex`. Full network blocking by default. Customizable via `[macos_seatbelt_profile_extensions]`.

### Windows

Restricted tokens with capability SIDs. ACL-based write deny on protected paths. Elevated setup with `codex-windows-sandbox-setup`.

### Key insight

Defense in depth — multiple independent layers. Each layer can fail without compromising overall security.

---

## Git & Worktree Handling

**Codex does NOT manage git worktrees.** It runs in the current working directory. Git operations:

- Async CLI commands with 5s timeout (no libgit2 dependency)
- Branch detection, merge-base computation, remote URL resolution
- Worktree-aware: `get_git_repo_root()` checks for `.git` file with `gitdir` entry
- `ghost_commits.rs` — synthetic commits for history preservation
- Parallel git info collection (commit hash, branch, remotes)

**Modules:** `codex-rs/utils/git/src/` — `operations.rs`, `branch.rs`, `apply.rs`, `ghost_commits.rs`, `platform.rs`

---

## `codex exec` — Headless Mode Interface

This is the interface orka uses for background sessions:

```bash
codex exec "PROMPT" \
  --full-auto \                          # skip all approvals
  --json \                               # JSONL output events
  --model gpt-5.2-codex \               # model selection
  --sandbox workspace-write \            # restrict writes to workspace
  --cd /path/to/worktree \              # working directory (KEY for orka)
  --add-dir /extra/writable \           # additional writable dirs
  --output-last-message /tmp/result.md \ # result extraction (KEY for orka)
  --ephemeral \                          # no session persistence
  --skip-git-repo-check \               # for non-standard git setups
  --dangerously-bypass-approvals-and-sandbox  # alias: --yolo
```

Also supports:
- `codex exec resume --last` — resume most recent session
- `codex exec review --base main` — code review mode
- `--image FILE` — attach images to prompt
- `--output-schema FILE` — JSON Schema for structured output
- `--color auto|always|never`
- `--progress-cursor` — cursor-based progress in exec mode

---

## Configuration System

**TOML-based** (`~/.codex/config.toml`):

```toml
[profiles.fast]
model = "gpt-4.1-mini"

[base_instructions]
# Merged from: ~/.codex → repo root → cwd (AGENTS.md files)

[mcp_servers.my-tool]
command = "npx"
args = ["my-mcp-server"]
```

**Loading stack:** built-in defaults → user config → managed config (enterprise) → CLI overrides (`-c key=value`)

**Permission model:**
- `suggest` — ask for every action
- `auto-edit` — auto-approve file edits, ask for commands
- `full-auto` — auto-approve everything within sandbox bounds

**Sandbox policies:**
- `ReadFullDisk` / `WriteFullDisk` — full access
- `ReadFullDisk + writable roots` — restricted writes
- `ReadRestricted + writable roots` — restricted read + write

---

## Session Management

- SQLite state DB (`~/.codex/state.db`)
- Sessions tracked by `ThreadId` (UUID)
- Rollout files for history/replay
- `ThreadManager::new_thread()` spawns Codex instances
- Events: `SessionConfigured`, `ItemStarted`, `ExecApprovalRequest`, etc.
- Token usage tracked per session

---

## Testing Approach

### Snapshot testing (TUI)
- `insta` crate for visual regression testing
- Snapshot diffs reviewed before accepting
- Tests in `codex-rs/tui/tests/` with `*.snap` files

### Integration tests
- Responses API mocking in `core_test_support`
- SSE payload helpers (`ev_*` constructors)
- `mount_sse_once` for single-request mock tests
- 153KB integration test file (`codex_tests.rs`)

### Unit testing patterns
- `pretty_assertions::assert_eq` for better diffs
- No mutation of process environment; pass flags instead
- `codex_utils_cargo_bin::cargo_bin()` for spawning workspace binaries
- `find_resource!` macro for fixture files
- Supports both Cargo and Bazel runtimes

---

## MCP (Model Context Protocol)

**As client:** Connects to external MCP servers configured in `[mcp_servers.*]`. Supports stdio and websocket transports.

**As server:** `codex mcp-server` runs Codex as MCP server for other clients. Special capability: `codex/sandbox-state` for dynamic sandbox updates.

**Shell tool MCP:** `@openai/codex-shell-tool-mcp` — provides `shell` tool with patched Bash/Zsh for execve interception. Rules-based command escalation (`.rules` files).

---

## Relevance to Orka

### What codex lacks (orka's value)

1. **No worktree management** — Codex runs in CWD, doesn't create/manage/merge worktrees
2. **No multi-session orchestration** — single agent at a time
3. **No session comparison/diffing** — can't compare outputs from parallel agents
4. **No relay/remote routing** — no multi-machine agent distribution
5. **No auto-merge/prune lifecycle** — no branch lifecycle management

### Current orka codex integration (`backends.ts`)

```typescript
function buildCodex(prompt, mode, model?) {
  parts = ["codex exec", "--full-auto", "--json"];
  if (model) parts.push(`--model ${model}`);
  parts.push(escaped_prompt);
}
```

### Recommended improvements

```typescript
function buildCodex(prompt, mode, opts?) {
  const parts = ["codex exec"];

  // Approvals and output
  parts.push("--full-auto");
  parts.push("--json");

  // Point codex at the worktree
  if (opts?.workingDir) {
    parts.push(`--cd ${shellEscape(opts.workingDir)}`);
  }

  // Restrict writes to workspace for safety
  parts.push("--sandbox workspace-write");

  // Direct result extraction (replaces log parsing)
  if (opts?.resultFile) {
    parts.push(`--output-last-message ${shellEscape(opts.resultFile)}`);
  }

  // Avoid codex's own session persistence (orka handles sessions)
  parts.push("--ephemeral");

  // Worktrees may look non-standard to codex's git check
  parts.push("--skip-git-repo-check");

  if (opts?.model) parts.push(`--model ${shellEscape(opts.model)}`);
  parts.push(shellEscape(prompt));

  return parts.join(" ");
}
```

### Patterns to adopt

| Pattern | Codex Implementation | Orka Adoption |
|---------|---------------------|---------------|
| **Streaming output** | 8KB chunks, delta events, 8MB cap | Add output capping to log tee, stream events from tmux |
| **Timeout safety** | 10s exec + 2s IO drain | Add per-session timeout config in `config.toml` |
| **Result extraction** | `--output-last-message FILE` | Use for `orka result` instead of parsing log files |
| **Sandbox integration** | `--sandbox workspace-write --cd DIR` | Pass worktree path to codex via `--cd` |
| **Session resumption** | `codex exec resume --last` | Enable `orka retry` to resume codex sessions |
| **Config stacking** | defaults → user → CLI overrides | Already similar, could formalize precedence |
| **Arg0 dispatch** | Single binary, multiple roles via argv[0] | Could unify orka CLI/daemon/relay into one binary |
| **SQLite state** | Session history + rollout tracking | Already using SQLite, could add audit log |
| **Event protocol** | JSON-RPC over bounded channels | Consider for `orka serve` internal protocol |
| **Apply-patch tool** | Pure Rust + tree-sitter | Future: custom editing tool for orka agents |
| **Parallel tool calls** | `FuturesOrdered` concurrent exec | Orka already parallelizes via tmux sessions |

### Architecture comparison

```
Codex (single-session agent):
  CLI → app-server → core agent loop → sandbox → tool execution
                                                      ↓
                                              result → user

Orka (multi-session orchestrator):
  CLI → daemon → tmux session → codex exec --cd WORKTREE
                                claude -p --permission-mode auto
                                shell command
                      ↓
              worktree → merge → main branch
              logs → result extraction
              traces → observability
```

Codex optimizes **within** a single agent session.
Orka optimizes **across** multiple agent sessions — spawning, routing, worktree lifecycle, merging results.

They are complementary, not competing.

---

## Key Files Reference

| Area | Path |
|------|------|
| CLI entry | `codex-rs/cli/src/main.rs` |
| Agent core | `codex-rs/core/src/codex.rs` (279KB) |
| Exec engine | `codex-rs/core/src/exec.rs` |
| Headless CLI | `codex-rs/exec/src/cli.rs` |
| Linux sandbox | `codex-rs/linux-sandbox/src/bwrap.rs` |
| Seccomp filter | `codex-rs/linux-sandbox/src/landlock.rs` |
| Apply-patch | `codex-rs/apply-patch/src/lib.rs` |
| Git utils | `codex-rs/utils/git/src/` |
| Config | `codex-rs/core/src/config/mod.rs` |
| State DB | `codex-rs/state/src/` |
| Protocol | `codex-rs/app-server-protocol/src/` |
| Session mgmt | `codex-rs/core/src/thread_manager.rs` |
| Integration tests | `codex-rs/core/src/codex_tests.rs` (153KB) |
| TUI snapshots | `codex-rs/tui/tests/` |
