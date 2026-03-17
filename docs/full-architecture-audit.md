# Full Architecture Audit — Orka

**Date:** 2026-03-17
**Scope:** Everything except session lifecycle/spawn paths (audited separately)

## Executive Summary

The Orka codebase demonstrates strong architectural discipline with clean type layering, proper dependency injection, secure cryptography, and well-separated packages. The main areas needing attention are: dashboard performance (ChatView god component, missing virtualization/memoization), relay instrumentation gaps, and CLI monolith size. No critical security issues found.

## Summary Table

| Area | Rating | Critical | High | Medium | Low |
|------|--------|----------|------|--------|-----|
| Dashboard | Good | 0 | 2 | 4 | 3 |
| Daemon | Excellent | 0 | 0 | 3 | 3 |
| Relay | Good | 0 | 1 | 4 | 4 |
| Core | Excellent | 0 | 0 | 0 | 2 |
| Client | Excellent | 0 | 0 | 0 | 2 |
| CLI | Good | 0 | 0 | 1 | 3 |
| Cross-cutting | Good | 0 | 0 | 2 | 2 |
| **Total** | | **0** | **3** | **14** | **19** |

---

## 1. Dashboard Architecture

**Location:** `packages/dashboard/`
**Size:** ~52 TS/TSX files, ~10,268 LOC

### 1.1 Component Structure

| Component | Lines | Assessment |
|-----------|-------|------------|
| `ChatView.tsx` | 996 | God component — needs refactoring |
| `ToolCallDetails.tsx` | 676 | Good — well-structured helpers |
| `App.tsx` | 667 | Good — orchestrator role |
| `OnboardingWizard.tsx` | 616 | Good — wizard pattern |
| `SessionView.tsx` | 401 | Good — tab container |
| `Sidebar.tsx` | 317 | Excellent — virtualized |
| `DiffPanel.tsx` | 291 | Good — error handling |
| `ErrorBoundary.tsx` | 274 | Excellent — comprehensive |

### 1.2 Findings

#### D-1: ChatView is a god component (HIGH)
- **File:** `dashboard/src/components/ChatView.tsx` (996 lines)
- **Problem:** 23 React hooks, complex business logic (`eventsToEntries` state machine), heavy ref management, chat rendering + event processing + approvals + scrolling all in one component
- **Fix:** Break into `ChatTimeline`, `ChatInputSection`, `ToolGroupRenderer`, `ApprovalRenderer`
- **Effort:** M

#### D-2: Chat history not virtualized (HIGH)
- **File:** `dashboard/src/components/ChatView.tsx`
- **Problem:** All chat entries render to DOM. Sessions with 1000+ messages will cause jank. Sidebar uses `@tanstack/react-virtual` properly but chat does not.
- **Fix:** Add virtualization to chat timeline (already have `@tanstack/react-virtual` installed)
- **Effort:** M

#### D-3: Chat entries rebuilt on every orchestration event (MEDIUM)
- **File:** `dashboard/src/components/ChatView.tsx:598`
- **Problem:** `setEntries(eventsToEntries(...))` called on every event. O(n) rebuild of entire entries array with no memoization.
- **Fix:** Wrap with `useMemo` or switch to incremental updates
- **Effort:** S

#### D-4: Missing React.memo on most components (MEDIUM)
- **File:** Multiple components
- **Problem:** Only `TimelineEntry` (ChatView:830) is memoized. All other components re-render on parent state changes unnecessarily.
- **Fix:** Add `React.memo` to stateless presentation components
- **Effort:** S

#### D-5: Unused dependencies in package.json (MEDIUM)
- **Package:** `@tanstack/react-router` (v1.160.0) — no routes, no RouterProvider found
- **Package:** `react-virtuoso` (v4.18.3) — Sidebar uses `@tanstack/react-virtual` instead
- **Impact:** ~100KB+ bundle bloat
- **Fix:** Remove unused deps
- **Effort:** S

#### D-6: Unconditional 10s node polling (MEDIUM)
- **File:** `dashboard/src/App.tsx:366`
- **Problem:** `setInterval(() => fetchNodes(), 10_000)` runs unconditionally. Could use exponential backoff or event-driven updates.
- **Fix:** Move to event-driven or add backoff
- **Effort:** S

#### D-7: Low test coverage (LOW)
- 6 test files out of ~52 source files (~11% file coverage)
- Tested: `useInputState`, `sessionStore`, `pathUtils`, `rpcLatencyStore`, `wsTransport`, `parseDiff`
- Gap: No tests for React components, no integration tests
- **Effort:** L

#### D-8: No retry UI (LOW)
- Most RPC call failures bubble to ErrorBoundary. No user-facing retry button except DiffPanel refresh.
- **Effort:** S

#### D-9: SearchInput in DiffPanel is a no-op (LOW)
- Search input exists in file list but filtering not implemented
- **Effort:** S

### 1.3 Strengths

- **State management:** 7 Zustand stores, clean separation, no overlapping state, proper localStorage error handling
- **Error boundary:** Comprehensive — catches React errors, unhandled promise rejections, window errors; auto-dismiss after 10s; OTel span reporting; deduplication
- **Mobile responsive:** `useMobileBreakpoint()` with `useSyncExternalStore`, dedicated mobile components (`MobileHeader`, `MobileTabBar`, `MobileSidebarDrawer`), safe-area insets, 44×44px tap targets
- **Data flow:** Clean unidirectional: WebSocket → Transport context → Stores/Hooks → Components
- **Timeline cache:** Hover prefetch with stale-while-revalidate pattern

---

## 2. Daemon Architecture

**Location:** `packages/daemon/`
**Size:** ~4,798 LOC across 10+ source files

### 2.1 Findings

#### DA-1: Unprotected JSON.parse in getSessionDiff (MEDIUM)
- **File:** `daemon/src/db.ts:353`
- **Problem:** `JSON.parse(row.last_diff)` can throw on corrupted data without span context
- **Fix:** Wrap in try-catch, return null on parse failure
- **Effort:** S

#### DA-2: Orphaned trace rotation files (MEDIUM)
- **File:** `daemon/src/tracing.ts:228`
- **Problem:** Async compression (`compressWithZstdAsync`) is fire-and-forget. If compression fails, `.rotating` files remain as orphans.
- **Fix:** Add cleanup on failure
- **Effort:** S

#### DA-3: Client error reporting inlined in RPC dispatch (MEDIUM)
- **File:** `daemon/src/rpc-handler.ts:238-246`
- **Problem:** `ctx.db.insertClientError({...})` called directly in dispatch instead of via a service method
- **Fix:** Extract to LocalClient for consistency
- **Effort:** S

#### DA-4: Trace compression reads full file into memory (LOW)
- **File:** `daemon/src/tracing.ts:220`
- **Problem:** TODO noted — should use streaming compression for 50MB+ files. Currently reads entire file.
- **Fix:** Refactor to streaming (documented TODO)
- **Effort:** M

#### DA-5: Silent config failures (LOW)
- **File:** `daemon/src/config.ts:99-100, 168`
- **Problem:** Missing config file and parse failures return empty config silently
- **Fix:** Add debug-level logging (intentionally silent by design, but harder to debug)
- **Effort:** S

#### DA-6: Migration catch suppresses all errors (LOW)
- **File:** `daemon/src/db.ts:179`
- **Problem:** Bare `catch` in migration block: `try { db.exec(sql); } catch { /* column may already exist */ }`
- **Fix:** Log at debug level; acceptable pattern but opaque
- **Effort:** S

### 2.2 Strengths

- **DaemonContext:** Excellent composition root (93 lines, 11 deps — appropriate for a daemon). All dependencies created once at startup, passed via constructor injection.
- **DB layer:** All raw SQL confined to `db.ts` (verified — zero SQL outside). 30 versioned migrations. All methods wrapped with `withSpanSync()`. Parameterized queries throughout (no injection risk).
- **RPC handler:** Full JSON-RPC 2.0 compliance. 50+ methods with explicit case dispatch. Proper error codes. Span context propagation.
- **PushHub:** No race conditions. Maps for subscriptions with proper cleanup. Set iteration safe under disconnection.
- **DI compliance:** Fully compliant. Zero module-level singletons (except documented OTel exception). All composition in `daemon-context.ts`.
- **Error handling:** Errors properly propagated via JSON-RPC responses. Logged (not swallowed) in background tasks. Provider failures mark sessions as "failed".

---

## 3. Relay Architecture

**Location:** `packages/relay/`
**Size:** ~2,400 LOC across 12 source files

### 3.1 Findings

#### R-1: Suspended accounts can initiate pairing (HIGH)
- **File:** `relay/src/index.ts:141`
- **Problem:** `/v1/pair/<enroll_id>` authenticates via `authManager.authenticate()` but doesn't check `account.status !== "active"`. Suspended accounts can still pair.
- **Fix:** Add `if (pairAuth.ctx.account.status !== "active")` check
- **Effort:** S

#### R-2: Node JSON parse errors silently dropped (MEDIUM)
- **File:** `relay/src/index.ts:448-453`
- **Problem:** If a node sends invalid JSON, the relay silently drops the message — no logging, no metrics, no trace. Makes debugging node issues hard.
- **Fix:** Log/trace dropped messages; increment error counter
- **Effort:** S

#### R-3: AbuseAction return type never used (MEDIUM)
- **File:** `relay/src/abuse.ts:25`
- **Problem:** `AbuseDetector.checkMessage()` computes an action but the return value is never acted upon. Dead return value.
- **Fix:** Either wire into message handling or remove the return type
- **Effort:** S

#### R-4: Missing metrics instrumentation (MEDIUM)
- **File:** `relay/src/tracing.ts`
- **Problem:** No metrics on: pairing slot lifecycle, transport_error counts, rate-limit rejections
- **Fix:** Add counters for pairing events, error responses, and rate limit hits
- **Effort:** S

#### R-5: Config leak in admin health endpoint (MEDIUM)
- **File:** `relay/src/api.ts:253-256`
- **Problem:** `/v1/admin/health` returns `config.abuse` thresholds — unnecessary information disclosure
- **Fix:** Remove or redact abuse config from health response
- **Effort:** S

#### R-6: No pagination on admin account list (LOW)
- **File:** `relay/src/api.ts:181-182`
- **Problem:** `/v1/admin/accounts` returns all accounts at once. For 10k+ accounts, this is problematic.
- **Fix:** Add `?limit=` and `?offset=` params
- **Effort:** S

#### R-7: index.ts is monolithic (LOW)
- **File:** `relay/src/index.ts` (602 lines)
- **Problem:** Contains HTTP routing, WebSocket upgrade, AND message forwarding (handleClientMessage, handleNodeMessage). Should be split.
- **Fix:** Extract transport forwarding to separate module
- **Effort:** M

#### R-8: Async trace compression unhandled (LOW)
- **File:** `relay/src/tracing.ts:133`
- **Problem:** `compressWithZstdAsync()` fire-and-forget — traces could be lost silently on compression failure
- **Fix:** Add error handler
- **Effort:** S

#### R-9: No E2E transport tests (LOW)
- **Problem:** No end-to-end test of client → relay → node flow. Also missing: API endpoint tests, auth cache invalidation tests, error handling tests.
- **Test files exist (1,018 lines):** state, pairing, auth, rate-limiter, config, abuse, metering, cluster
- **Fix:** Add E2E WebSocket tests
- **Effort:** L

### 3.2 Strengths

- **Transport forwarding:** Account isolation enforced properly. `_rc` field always overwritten by relay (no injection). Cross-account routing impossible (keys include `${accountId}:${relayCid}`).
- **Auth:** SHA-256 key hashing, 5-minute LRU cache, account status checks, key revocation support, last-used batch updates.
- **Rate limiting:** Sliding window with per-minute and per-hour limits, global per-second safety valve, connection count and message size limits.
- **State management:** Maps with proper cleanup on disconnect. Transport binding cleanup correct on node disconnect (notifies clients, removes bindings).
- **Shutdown:** Sets draining flag, calls shutdown() on all subsystems, drains connections, closes DB, waits for tracing shutdown.

---

## 4. Core Package (@orka/core)

**Location:** `packages/core/`
**Size:** ~2,400 LOC across 37 files

### 4.1 Findings

No medium or high severity issues.

#### C-1: Noise transport doesn't zeroize key material (LOW)
- **File:** `core/src/crypto/noise.ts`
- **Problem:** `CipherState._k` goes out of scope naturally but isn't explicitly zeroed after use. Acceptable for Bun/Node runtime.
- **Effort:** S

#### C-2: Transport payload serialized fresh each time (LOW)
- **File:** `core/src/transport/noise-transport.ts:195`
- **Problem:** No buffer reuse on encrypt — acceptable for correctness/security but minor perf overhead under high throughput
- **Effort:** N/A (by design)

### 4.2 Strengths

- **Type layering:** Exemplary. Domain types in `types.ts`, API response DTOs in `service.ts`, DB row types stay in daemon. `env` excluded from all API responses. List endpoints return summary DTOs, detail endpoints return full DTOs.
- **OrkaService interface:** 40 methods across 8 logical domains. All return `Promise<T>` for network transparency. Session-ID-centric (no paths in API). Optional methods marked for graceful degradation.
- **Noise NK crypto:** Textbook implementation. Correct X25519 key exchange, ChaCha20-Poly1305 AEAD, 12-byte nonce with overflow protection, prologue binding for both hellos + relay origin.
- **Zod schemas:** Properly structured with `.passthrough()` for forward compatibility. Discriminated unions with `.or(z.string())` fallback. No zod/v4 default gotchas found.
- **Exports:** Carefully curated. `crypto.ts` excluded from main index (uses `node:crypto`), only importable via `@orka/core/crypto`. Browser-safe main export.

---

## 5. Client Package (@orka/client)

**Location:** `packages/client/`
**Size:** ~700 LOC across 11 files

### 5.1 Findings

No medium or high severity issues.

#### CL-1: Noise handshake handler not restored on WebSocket error (LOW)
- **File:** `client/src/noise-handshake.ts:34`
- **Problem:** If WebSocket errors mid-handshake, `originalOnMessage` isn't explicitly restored. Mitigated: reconnect starts fresh.
- **Effort:** S

#### CL-2: RPC response ID normalization edge case (LOW)
- **File:** `client/src/ws-transport.ts:722-735`
- **Problem:** String/number ID normalization could be fragile if relay swaps types. Currently correct since both sides are controlled.
- **Effort:** N/A

### 5.2 Strengths

- **Reconnection:** Exponential backoff with jitter (1s base, 60s max, ±30% jitter). Thundering herd prevention. Proper cleanup of pending requests on disconnect.
- **Push channels:** Handler sets per channel, channel-specific transforms for validation, late subscribers get last received value, gap detection and reporting.
- **Browser safety:** Main export is browser-safe. `known-hosts.ts` (uses `node:fs`, `node:path`) NOT re-exported from index. Only importable directly via `@orka/client/known-hosts`.
- **Protocol version checking:** Compares server version against client range, emits `protocol.mismatch` for graceful degradation.

---

## 6. CLI

**Location:** `packages/cli/src/index.ts`
**Size:** 3,240 lines (single file)

### 6.1 Findings

#### CLI-1: Single-file monolith at 3240 lines (MEDIUM)
- **Problem:** All 29 commands (20 documented + 9 extensions) in one file. Manageable now but approaching the threshold where refactoring becomes necessary (~4000-5000 lines).
- **Fix:** Extract to `commands/spawn.ts`, `commands/admin.ts`, `commands/node.ts`, `utils/daemon.ts`, `utils/encryption.ts`
- **Effort:** L

#### CLI-2: Color handling inconsistency (LOW)
- **Files:** `cli/src/index.ts:976`, `cli/src/index.ts:1541`, `cli/src/index.ts:1840`
- **Problem:** Three different NO_COLOR check patterns across the file
- **Fix:** Extract to utility function
- **Effort:** S

#### CLI-3: Inconsistent error handling in stop command (LOW)
- **File:** `cli/src/index.ts:1220`
- **Problem:** Uses `console.warn()` instead of `fail()` for already-stopped session
- **Fix:** Change to `fail()` for consistency
- **Effort:** S

#### CLI-4: getSvc() singleton acceptable but documented (LOW)
- **File:** `cli/src/index.ts:568`
- **Assessment:** Documented exception in CLAUDE.md. Proper cleanup in `runCliCommand()` finally block. Acceptable as composition root.

### 6.2 Strengths

- **Command completeness:** All 20 documented commands plus 9 useful extensions (dashboard, close, archive, unarchive, backfill, traces, usage, node, restart)
- **Daemon auto-start:** Robust — health check with 500ms timeout, setsid for detachment, log rotation (10MB limit, 3 rotated files, zstd compression), PID validation via `/proc/<pid>/cmdline`, 5s startup poll with diagnostics
- **Security:** No command injection (static argv arrays, no shell invocation), proper env var precedence (CLI args > env vars > files), TOFU key verification with change warnings, PID validated as orka process before kill
- **Error messages:** Consistently formatted, include usage hints, proper exit codes

---

## 7. Cross-Cutting Concerns

### 7.1 Dead Code

**Severity: Low**

No significant dead code found across packages. All exports are used. No commented-out blocks. The only dead code is `AbuseAction` return value in relay (R-3 above).

### 7.2 Naming Consistency

**Assessment: Excellent**

- Commands: kebab-case (`spawn`, `ps`, `logs`)
- Types: PascalCase (`OrkaService`, `SpawnRequest`, `Session`)
- Functions: camelCase (`findSession`, `getDashboardDir`)
- Constants: UPPER_SNAKE_CASE (`DEFAULT_DAEMON_PORT`, `DAEMON_LOG_MAX_BYTES`)
- No inconsistencies found across packages.

### 7.3 Test Coverage

| Package | Test Files | Source Files | Coverage |
|---------|-----------|--------------|----------|
| Dashboard | 6 | ~52 | ~11% |
| Daemon | 10+ | ~15 | ~65% |
| Relay | 8 | 12 | ~67% |
| Core | 15+ | 37 | ~40% |
| Client | 3 | 11 | ~27% |
| E2E | 11 | — | — |
| **Total** | **65** | **~112** | **~58%** |

**Strong coverage:** Crypto (noise, hash, spake2), pairing protocol (712 lines), transport protocol (673 lines), orchestration (engine, consumer, checkpoint), relay unit tests (state, pairing, auth, rate-limiter)

**Coverage gaps (XC-1, MEDIUM):**
- `daemon/src/orchestrator.ts` (673 lines, core logic)
- `core/src/crypto.ts` (127 lines, security-critical hashing)
- Dashboard React components (0% component test coverage)
- Relay API endpoints (no HTTP tests)
- CLI commands (covered only by E2E)

### 7.4 Dependencies

**Unused dashboard deps (XC-2, MEDIUM):**
- `@tanstack/react-router` v1.160.0 — not used anywhere
- `react-virtuoso` v4.18.3 — Sidebar uses `@tanstack/react-virtual` instead

No other unused or obviously outdated dependencies found in other packages.

### 7.5 DI Violations

All known and documented in CLAUDE.md:
1. `relay/src/tracing.ts:109` — `export const metrics` singleton (17 usages, documented as ~25)
2. `cli/src/index.ts:568` — `getSvc()` singleton (composition root, acceptable)
3. `daemon/src/orchestrator.ts:21` — `idleTimers` module-level Map (session lifecycle, acceptable)

No undocumented violations found.

### 7.6 Security

No critical issues. Specific observations:
- All SQL parameterized (no injection risk)
- No `eval()`, no unsafe deserialization
- Noise NK crypto implementation is correct
- TOFU key pinning with change warnings
- `env` properly excluded from API responses
- PID files validated before signals sent
- Process spawning uses static argv (no shell injection)

### 7.7 Build & Dev Experience

- Bun workspace setup is clean (`workspaces` in root package.json)
- `bun test packages/ tests/` runs all tests
- Dashboard uses Vite with proxy to daemon WS
- No `bun run check` command found — type checking requires manual `tsc`
- `bun run lint:di` exists for DI violation checking
- Docker files present for relay and daemon

### 7.8 CLAUDE.md Accuracy

CLAUDE.md is **accurate and up-to-date** with two minor discrepancies:
1. Relay metrics singleton documented as "25 occurrences" — actual count is 17
2. CLI documented as "20 commands" — actual count is 29 (20 + 9 extensions)

---

## Prioritized Recommendations

### High Priority (do soon)

| ID | Finding | Package | Effort |
|----|---------|---------|--------|
| D-1 | ChatView god component (996 lines) — refactor | Dashboard | M |
| D-2 | Chat history not virtualized — jank with large sessions | Dashboard | M |
| R-1 | Suspended accounts can initiate pairing | Relay | S |

### Medium Priority (do when touching nearby code)

| ID | Finding | Package | Effort |
|----|---------|---------|--------|
| D-3 | Chat entries rebuilt every event — add useMemo | Dashboard | S |
| D-4 | Missing React.memo on presentation components | Dashboard | S |
| D-5 | Unused deps (@tanstack/react-router, react-virtuoso) | Dashboard | S |
| D-6 | Unconditional 10s node polling | Dashboard | S |
| DA-1 | Unprotected JSON.parse in getSessionDiff | Daemon | S |
| DA-2 | Orphaned trace rotation files | Daemon | S |
| DA-3 | Client error reporting inlined in RPC dispatch | Daemon | S |
| R-2 | Node JSON parse errors silently dropped | Relay | S |
| R-3 | AbuseAction return type never used | Relay | S |
| R-4 | Missing metrics (pairing, errors, rate limits) | Relay | S |
| R-5 | Config leak in admin health endpoint | Relay | S |
| CLI-1 | CLI monolith at 3240 lines — consider split | CLI | L |
| XC-1 | Test coverage gaps (orchestrator, crypto, components) | Cross | L |
| XC-2 | Unused dashboard dependencies | Dashboard | S |

### Low Priority (nice to have)

| ID | Finding | Package | Effort |
|----|---------|---------|--------|
| D-7 | Low dashboard test coverage (~11%) | Dashboard | L |
| D-8 | No retry UI on RPC failures | Dashboard | S |
| D-9 | SearchInput in DiffPanel is a no-op | Dashboard | S |
| DA-4 | Trace compression reads full file into memory | Daemon | M |
| DA-5 | Silent config failures | Daemon | S |
| DA-6 | Migration catch suppresses all errors | Daemon | S |
| R-6 | No pagination on admin account list | Relay | S |
| R-7 | relay/src/index.ts monolithic (602 lines) | Relay | M |
| R-8 | Async trace compression unhandled | Relay | S |
| R-9 | No E2E transport tests | Relay | L |
| C-1 | No key material zeroization in Noise | Core | S |
| CL-1 | Noise handshake handler not restored on error | Client | S |
| CLI-2 | Color handling inconsistency (3 patterns) | CLI | S |
| CLI-3 | Inconsistent error handling in stop command | CLI | S |

---

## Architecture Verdict

The Orka codebase is **well-architected** with:

- **Excellent:** Type layering, DI compliance, crypto implementation, DB isolation, error boundaries, mobile responsiveness
- **Good:** State management, RPC dispatch, relay transport, auth/rate-limiting, CLI completeness
- **Needs attention:** Dashboard performance (ChatView refactor, virtualization, memoization), relay instrumentation, test coverage expansion

No critical issues. No security vulnerabilities. No dead code accumulation. The codebase follows its own CLAUDE.md guidelines consistently.
