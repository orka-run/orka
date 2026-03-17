# Production Readiness Audit

**Date**: 2026-03-15
**Scope**: Orka codebase — daemon, relay, CLI, core, dashboard
**Perspective**: Senior SRE / security engineer evaluating deployment for a team of 10+ developers

---

## 1. Security

### S1. No Authentication on Local Daemon WebSocket
**Severity**: High
**Location**: `packages/daemon/src/server.ts:75-140`

The daemon WebSocket server accepts all connections without authentication. It binds to `127.0.0.1:7394` and relies entirely on localhost network isolation for security. Any local process can connect and issue RPCs — spawn sessions, read logs, stop sessions, access all session data.

The `/health` endpoint and `/session-ended` callback are also unauthenticated.

**Risk**: On shared machines (CI runners, dev VMs, pair-programming setups), any user process can hijack sessions. Container escape or port-forwarding exposes the full API.

**Recommendation**: Add optional local auth via a file-based bearer token written to `~/.orka/daemon.token` with `0600` permissions. CLI reads the token automatically; other processes need explicit access.

---

### S2. Agents Run Without Sandbox
**Severity**: High
**Location**: `packages/daemon/src/adapters/claude-adapter.ts:703`, `packages/daemon/src/adapters/codex-adapter.ts:204`

Background Claude Code sessions run with `--permission-mode bypassPermissions`. Codex sessions run with `--dangerously-bypass-approvals-and-sandbox`. Agents have unrestricted filesystem, network, and command execution access.

Agents also inherit the daemon's full environment (`{ ...globalThis.process.env, ...input.env }` at `claude-adapter.ts:113`, `codex-adapter.ts:211`), which may contain API keys, database credentials, and other secrets not relevant to the agent's task.

**Risk**: A malicious or confused prompt could lead to data exfiltration, secret leakage, or system damage. Environment inheritance means agents see every secret available to the daemon process.

**Recommendation**:
- Filter environment variables before passing to agents — only pass explicitly allowed vars
- Document the sandbox bypass as a known design tradeoff
- Consider adding an `allowedEnvVars` config option
- Long-term: explore container-based isolation or seccomp profiles

---

### S3. No Key Rotation or Revocation for Noise Keys
**Severity**: Medium
**Location**: `packages/core/src/crypto.ts:113-119`

Noise keys are auto-generated on first use via `ensureNoiseKeyPair()` and stored at `~/.orka/keys/` with correct permissions (`0600` for private, `0644` for public). However, there is no rotation mechanism, no expiration, and no revocation. A compromised key remains valid indefinitely.

The known-hosts TOFU model (`packages/client/src/known-hosts.ts`) has no way to revoke a previously trusted server key.

**Recommendation**: Add `orka keygen rotate` that generates a new keypair and invalidates the old one. Add key age warnings. Add `orka keygen revoke <key-id>` for known-hosts cleanup.

---

### S4. Relay Query Parameter Token Exposure
**Severity**: Medium
**Location**: `packages/relay/src/auth.ts:330`

Relay authentication supports tokens via `?token=<key>` query parameters. Query parameters are logged in proxy access logs, browser history, HTTP Referrer headers, and server request logs.

**Recommendation**: Deprecate query parameter auth. Use only `Authorization: Bearer <key>` header. If query params must stay for WebSocket connections (which can't set headers), rotate the token after initial handshake.

---

### S5. Post-Worktree-Create Hook Executes Config Strings via Bash
**Severity**: Low (user-controlled config)
**Location**: `packages/daemon/src/worktree.ts:78`

Hook commands from `~/.orka/config.toml` are passed directly to `bash -c`. This is intentional (hooks are user-defined), but if the config file is writable by another user or compromised, it's arbitrary code execution.

**Recommendation**: Ensure `~/.orka/config.toml` has `0600` permissions. Document that hooks run as the daemon user.

---

### S6. Relay Legacy Token Backdoor
**Severity**: Low
**Location**: `packages/relay/src/auth.ts:201-221`

The relay supports a `legacyToken` config option that creates a synthetic auth context with account ID `__legacy__` and hardcoded `pro` tier, bypassing the normal API key system.

**Recommendation**: Remove legacy token support or add a startup warning when it's configured. Ensure it's not used in production deployments.

---

## 2. Reliability

### R1. Orchestration Engine Unbounded In-Memory Event Log
**Severity**: High
**Location**: `packages/daemon/src/orchestration/engine.ts:24,54`

`OrchestrationEngine.log` is an append-only in-memory array. Every orchestration event for every session is pushed to this array and never cleaned up. For a daemon running continuously with many sessions, this grows without bound.

Additionally, `projectSessionState()` at line 149 iterates the entire log array filtering by sessionId — O(n) per session query where n is total events across all sessions.

**Risk**: Memory exhaustion over days/weeks of continuous daemon operation. Performance degradation as the log grows.

**Recommendation**: Evict events for completed sessions from the in-memory log (they're already persisted to SQLite via `persistEvent`). The `getSessionTimeline` callback already supports loading from DB on-demand.

---

### R2. Relay SQLite Missing `busy_timeout`
**Severity**: High
**Location**: `packages/relay/src/db.ts:113-114`

The relay database sets WAL mode and foreign keys but does NOT set `PRAGMA busy_timeout`. The daemon correctly sets `busy_timeout = 5000` at `packages/daemon/src/db.ts:85`. Under concurrent write load from metering and auth operations, relay queries can fail with `SQLITE_BUSY`.

**Recommendation**: Add `db.exec("PRAGMA busy_timeout = 5000")` to relay DB initialization.

---

### R3. Relay Reconnect Timer Missing `.unref()`
**Severity**: High
**Location**: `packages/daemon/src/server.ts:539`

When the relay connection drops, `setTimeout(connect, delay)` is called without `.unref()`. This keeps the Node.js event loop alive indefinitely, preventing the daemon process from exiting naturally. Can result in zombie daemon processes that consume resources but serve no purpose.

**Recommendation**: Add `.unref()` to the relay reconnect timer.

---

### R4. Daemon Crash Leaves Sessions Orphaned
**Severity**: High
**Location**: `packages/daemon/src/orchestrator.ts:131-157`

Provider event consumers are fire-and-forget (`void consumeProviderEvents(...)`). If the daemon crashes:
- Running sessions have no provider handle to resume them
- Sessions remain in "running" status in the DB despite no process backing them
- On daemon restart, there's no recovery — `reapSessions()` is a no-op (line 167)

**Recommendation**: On daemon startup, scan for sessions in "running" status with no active provider handle and mark them as "cancelled" with a reason. Add a `--recover` flag or automatic stale-session detection.

---

### R5. PID File Handling Is Fragile
**Severity**: Medium
**Location**: `packages/cli/src/index.ts:160,190-195`

Multiple issues:
1. PID files (`daemon.pid`, `dashboard.pid`) are never cleaned up on graceful shutdown
2. `parseInt()` on a malformed file returns `NaN`, which is falsy — `if (pid)` silently skips the kill
3. No validation that the PID belongs to an actual Orka daemon (could be a recycled PID)
4. Stale PID files after crashes can cause the CLI to SIGTERM unrelated processes

**Recommendation**: Delete PID file in graceful shutdown handler. Validate PID ownership via `/proc/<pid>/cmdline` or process name check. Use file locking to prevent concurrent daemon starts.

---

### R6. Worktree Cleanup Never Auto-Runs
**Severity**: Medium
**Location**: `packages/daemon/src/orchestrator.ts:311-342`

`cleanupOrphanedWorktrees()` exists but is only called via manual `orka prune`. There's no periodic garbage collection, no startup cleanup, and no disk space monitoring. Worktrees at `~/.orka/worktrees/` accumulate indefinitely.

Each worktree is a full copy of the repository. For a team generating dozens of sessions per day, disk usage grows rapidly.

**Recommendation**: Run orphan cleanup on daemon startup and periodically (e.g., daily). Add configurable max-age for completed session worktrees. Add disk usage warnings.

---

### R7. No Timeout for Stuck Provider Sessions
**Severity**: Medium
**Location**: `packages/daemon/src/orchestration/consumer.ts:62-68`, `packages/daemon/src/provider-service.ts:12`

The `for await` loop consuming provider events has no timeout or heartbeat. If a provider adapter hangs silently, the session stays "running" forever. The provider handle remains in the `sessions` Map indefinitely.

**Recommendation**: Add a configurable session timeout (e.g., `session.maxDurationMs`). Add heartbeat detection — if no events received for N minutes, mark session as failed.

---

### R8. Migration Error Handling Is Silent
**Severity**: Low
**Location**: `packages/daemon/src/db.ts:173-178`, `packages/relay/src/db.ts:189`

Both daemon and relay databases use `try { db.exec(sql); } catch { /* column may already exist */ }` for migrations. If a migration fails for an unexpected reason, the error is silently swallowed, potentially leaving the schema in an inconsistent state.

**Recommendation**: Check for the specific error (e.g., "duplicate column name") instead of catching all errors. Log unexpected migration failures as warnings.

---

### R9. LogTailer Session Offsets Never Cleared
**Severity**: Low
**Location**: `packages/daemon/src/log-tailer.ts:10,83-85`

The `offsets` Map tracks file read positions per session but never removes entries for completed sessions. A `forget()` method exists but is never called. Minor memory accumulation over the daemon's lifetime.

**Recommendation**: Call `forget(sessionId)` when a session reaches terminal status.

---

## 3. Operational

### O1. Health Check Is Shallow
**Severity**: High
**Location**: `packages/daemon/src/server.ts:83-98`

The `/health` endpoint returns status, version, and capabilities but does not check:
- Database connectivity
- Active session count / concurrent limit headroom
- Disk space availability
- Memory usage
- WebSocket connection count

**Risk**: A daemon can report healthy while the database is corrupted, disk is full, or resources are exhausted.

**Recommendation**: Add liveness checks for database (simple query), disk (stat the data directory), and resource limits. Return HTTP 503 when unhealthy.

---

### O2. Unbounded `traces.jsonl` Growth
**Severity**: High
**Location**: `packages/daemon/src/tracing.ts:217-225`

The file-based trace exporter appends to `~/.orka/traces.jsonl` without rotation or size limits. On a busy daemon, this file grows indefinitely until disk exhaustion.

**Recommendation**: Implement size-based or time-based rotation. Consider a max file size (e.g., 100MB) with rollover.

---

### O3. Daemon Log Rotation Missing
**Severity**: Medium
**Location**: `packages/cli/src/index.ts:159`, daemon log at `~/.orka/logs/daemon.log`

Daemon stdout/stderr is redirected to a single log file that grows without rotation. Session logs at `~/.orka/logs/<session-id>.log` also accumulate without cleanup policy.

**Recommendation**: Rotate `daemon.log` on daemon restart. Add session log cleanup to `orka prune`. Document recommended logrotate config for production.

---

### O4. Provider Sessions Lost on Daemon Restart
**Severity**: Medium
**Location**: `packages/daemon/src/orchestrator.ts:189-193`

Running sessions lose their provider handles on daemon restart. The daemon marks them as "cancelled" but cannot resume the underlying Claude Code or Codex processes. Users lose work.

**Recommendation**: Document this limitation clearly. Add a `--drain` mode that waits for running sessions to complete before restarting. Long-term: explore session process detachment from daemon.

---

### O5. No Configurable Session Timeout or Idle Limit
**Severity**: Medium
**Location**: `packages/daemon/src/config.ts`

There is no `session.maxDurationMs` or `session.idleTimeoutMs` config. Sessions can run indefinitely. Combined with `maxConcurrent = 0` (unlimited by default), a runaway agent could monopolize resources.

**Recommendation**: Add configurable session timeout and idle detection. Default `maxConcurrent` to a reasonable value (e.g., 5 or 10) instead of unlimited.

---

### O6. Slow RPC Threshold Not Configurable
**Severity**: Low
**Location**: `packages/daemon/src/rpc-handler.ts:7`

`SLOW_RPC_THRESHOLD_MS = 1_000` is hardcoded. Different deployments may need different thresholds.

**Recommendation**: Make configurable via config.toml.

---

## 4. Performance

### P1. Orchestration Event Log Linear Scan
**Severity**: Medium
**Location**: `packages/daemon/src/orchestration/engine.ts:100-103,149-152`

`getSessionEvents()` filters the entire in-memory log with `.filter()`. `projectSessionState()` iterates all events looking for a specific sessionId. Both are O(n) where n is the total number of events across all sessions.

**Recommendation**: Index events by sessionId using a `Map<string, OrchestrationEvent[]>` instead of a flat array.

---

### P2. Missing Database Index on `sessions.archived_at`
**Severity**: Medium
**Location**: `packages/daemon/src/db.ts:343,358,366,377`

Multiple queries filter by `archived_at IS NULL` but there's no index on this column. With thousands of sessions, list queries slow down.

**Recommendation**: Add `CREATE INDEX idx_sessions_archived_at ON sessions(archived_at)`.

---

### P3. `SELECT *` Anti-Pattern in DB Queries
**Severity**: Low
**Location**: `packages/daemon/src/db.ts:228,335,346,349,675`

Sessions table has 25+ columns. All queries use `SELECT *` even when only a few columns are needed. Wastes memory and bandwidth for list operations.

**Recommendation**: Select specific columns for list queries. Keep `SELECT *` only for single-row fetches that need all fields.

---

### P4. WebSocket Broadcast Is Sequential Per Subscriber
**Severity**: Low
**Location**: `packages/daemon/src/push-hub.ts:114-137`

Broadcasts send to all subscribers sequentially. A slow client blocks delivery to others. No per-client buffering or backpressure mechanism. Warning threshold at 256KB (line 5) is logged but not acted upon.

**Recommendation**: Drop messages for slow clients (or disconnect them) rather than blocking the broadcast loop. Add metrics on broadcast latency.

---

### P5. Worktree Post-Create Hooks Block Spawn
**Severity**: Low
**Location**: `packages/daemon/src/worktree.ts:71-95`

Post-create hooks (e.g., `npm install`) run sequentially and block the spawn operation. Slow network or large dependency installs delay session start.

**Recommendation**: Run hooks asynchronously and report hook status via events. Allow sessions to start while hooks run.

---

## 5. UX / Developer Experience

### U1. No `orka last` or Session Shorthand
**Severity**: Medium

Common workflows require manually copying session IDs. There's no shortcut for "the most recent session" which is the most common target for `logs`, `diff`, `show`, `merge`.

**Recommendation**: Add `orka last` alias or support `@last` / `@1` syntax (most recent, second most recent, etc.).

---

### U2. No Batch Operations by Tag
**Severity**: Medium

Can't `orka stop --tag migration` to stop all sessions with a tag. Must list sessions, extract IDs, and stop individually. Similarly, no `orka ps --tag X -q` quiet mode for scripting.

**Recommendation**: Add `--tag` filtering to `stop`, `wait`, `merge`. Add `-q` quiet mode that outputs only session IDs.

---

### U3. Daemon Start Failure Gives Unhelpful Error
**Severity**: Low
**Location**: `packages/cli/src/index.ts:181`

When daemon fails to start within 5s, the error says "timed out waiting for health check" with a pointer to the log file. Users must manually `cat` the log file to find the actual error.

**Recommendation**: Automatically tail the last 20 lines of `daemon.log` on startup failure.

---

### U4. No `orka spawn --watch` to Auto-Attach
**Severity**: Low

The most common workflow is `orka spawn ... && orka logs -f <id>`. There's no compound command to spawn and immediately stream output.

**Recommendation**: Add `--watch` / `--follow` flag to `orka spawn` that automatically streams logs after spawn.

---

## 6. Code Quality

### C1. CLI Is a Single 2951-Line File with Zero Tests
**Severity**: High
**Location**: `packages/cli/src/index.ts`

The entire CLI (20 commands, argument parsing, daemon lifecycle, dashboard management) is in one monolithic file with no test coverage. This is the primary user-facing interface.

**Recommendation**: Extract commands into individual modules. Add integration tests using a test adapter (which doesn't require real AI API keys).

---

### C2. Core Package Has No Unit Tests
**Severity**: High
**Location**: `packages/core/src/`

11 source modules (crypto, types, RPC definitions, orchestration schemas, push protocol) have no tests. These are the foundation types used by all other packages.

**Recommendation**: Add tests for crypto operations, schema validation, and type coercion. These are stable, pure-logic modules ideal for unit testing.

---

### C3. Orchestrator and Backend Command Builder Untested
**Severity**: High
**Location**: `packages/daemon/src/orchestrator.ts` (366 LOC), `packages/daemon/src/backends.ts` (165 LOC)

The core session lifecycle (spawn, stop, cleanup) and backend command building (shell escaping, flag construction) have no unit tests despite being critical paths.

**Recommendation**: Add unit tests for `buildBackendCommand()` with edge cases (special characters in prompts, env var validation). Add orchestrator tests using mock provider handles.

---

### C4. 130+ `as any` Type Casts
**Severity**: Medium
**Location**: `packages/relay/src/db.ts` (14), `packages/daemon/src/db.ts` (8), `packages/daemon/src/aggregating-client.ts` (9), various

Extensive use of `as any` for SQLite row parsing and RPC dispatch. Undermines TypeScript's safety guarantees.

**Recommendation**: Introduce branded types or runtime validators (zod) for DB row parsing. Replace dynamic dispatch `svc[method](params)` with a typed method map.

---

### C5. Codex Sandbox TODO Still Open
**Severity**: Low
**Location**: `packages/daemon/src/backends.ts:114`

`TODO(orka-bt3): re-enable sandbox with lifecycle hooks for dep install` — Codex runs with `--dangerously-bypass-approvals-and-sandbox` permanently as a "temporary" measure.

**Recommendation**: Track this as a formal issue. Either implement sandbox support or document the permanent bypass as an accepted risk.

---

## Summary Table

| ID | Area | Severity | Finding |
|----|------|----------|---------|
| S1 | Security | High | No auth on local daemon WebSocket |
| S2 | Security | High | Agents run without sandbox, inherit all env vars |
| S3 | Security | Medium | No key rotation/revocation for Noise keys |
| S4 | Security | Medium | Relay token exposed in query parameters |
| S5 | Security | Low | Config-sourced hooks run via bash -c |
| S6 | Security | Low | Legacy token backdoor in relay |
| R1 | Reliability | High | Unbounded in-memory orchestration event log |
| R2 | Reliability | High | Relay SQLite missing busy_timeout |
| R3 | Reliability | High | Relay reconnect timer missing .unref() |
| R4 | Reliability | High | Daemon crash leaves sessions orphaned |
| R5 | Reliability | Medium | PID file handling is fragile |
| R6 | Reliability | Medium | Worktree cleanup never auto-runs |
| R7 | Reliability | Medium | No timeout for stuck provider sessions |
| R8 | Reliability | Low | Migration error handling is silent |
| R9 | Reliability | Low | LogTailer session offsets never cleared |
| O1 | Operational | High | Health check is shallow |
| O2 | Operational | High | Unbounded traces.jsonl growth |
| O3 | Operational | Medium | Daemon log rotation missing |
| O4 | Operational | Medium | Provider sessions lost on restart |
| O5 | Operational | Medium | No configurable session timeout |
| O6 | Operational | Low | Slow RPC threshold hardcoded |
| P1 | Performance | Medium | Event log linear scan per session query |
| P2 | Performance | Medium | Missing index on sessions.archived_at |
| P3 | Performance | Low | SELECT * anti-pattern in DB queries |
| P4 | Performance | Low | WebSocket broadcast sequential per subscriber |
| P5 | Performance | Low | Post-create hooks block spawn |
| U1 | UX | Medium | No session shorthand / orka last |
| U2 | UX | Medium | No batch operations by tag |
| U3 | UX | Low | Unhelpful daemon start failure error |
| U4 | UX | Low | No spawn --watch |
| C1 | Code Quality | High | CLI is 2951 LOC monolith with zero tests |
| C2 | Code Quality | High | Core package has no unit tests |
| C3 | Code Quality | High | Orchestrator and backends untested |
| C4 | Code Quality | Medium | 130+ as any type casts |
| C5 | Code Quality | Low | Codex sandbox bypass TODO still open |

## Prioritized Action Items

### Must-fix before production (Critical/High)

1. **R2**: Add `busy_timeout` to relay SQLite — one-line fix
2. **R3**: Add `.unref()` to relay reconnect timer — one-line fix
3. **R1**: Evict completed session events from in-memory log
4. **R4**: Detect and recover stale "running" sessions on daemon startup
5. **O2**: Add trace file rotation
6. **O1**: Expand health check to cover DB, disk, session count
7. **S1**: Add optional local daemon auth token
8. **S2**: Filter environment variables passed to agents

### Should-fix before team rollout

9. **R5**: Fix PID file lifecycle (cleanup on shutdown, validate ownership)
10. **R6**: Auto-run worktree cleanup on daemon startup
11. **R7**: Add session timeout watchdog
12. **O5**: Add configurable maxConcurrent default and session timeout
13. **O3**: Add log rotation
14. **S3**: Add key rotation support

### Testing debt (should parallelize with above)

15. **C3**: Test orchestrator and backend command builder
16. **C2**: Test core crypto and schema modules
17. **C1**: Extract CLI commands into modules and add integration tests

### Nice-to-have

18. **U1**: Add `orka last` shorthand
19. **U2**: Add `--tag` filtering to stop/wait/merge
20. **P1**: Index in-memory events by sessionId
21. **P2**: Add archived_at index
22. **S4**: Deprecate query parameter auth
