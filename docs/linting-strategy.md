# Linting Strategy — Architecture, Security, Protocol Checks

## Current State

### What we have

| Tool | Config | Scope | Notes |
|------|--------|-------|-------|
| **TypeScript** | `tsconfig.json` (strict) | All packages | `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` at root; some packages relax these |
| **ESLint** | `eslint.config.mjs` (flat config) | `packages/*/src/**`, `tests/**` | `strictTypeChecked` + `recommendedTypeChecked` |
| **DI Linter** | `scripts/lint-di.ts` | `packages/` | Checks: `extends`, `mock.module()`, singleton patterns |
| **CI command** | `bun run check` | All | Sequential: `typecheck → lint → lint:di` |

### What we don't have

- **No pre-commit hooks** — developers must manually `bun run check`
- **No import boundary enforcement** — nothing prevents cross-package violations
- **No architecture/layer linting** — SELECT *, sensitive field leaks, type layer violations
- **No security-specific checks** — crypto hygiene, secrets exposure, SQL patterns
- **No protocol consistency checks** — relay allowlist sync, dead channels, event coverage
- **No dead code detection** — unused exports, dead event types, dead push channels
- **No test quality enforcement** — assertion-less tests pass silently

### Notable ESLint rules already enabled

```
@typescript-eslint/no-explicit-any: error
@typescript-eslint/no-unsafe-*: error (all 5 variants)
@typescript-eslint/no-unnecessary-condition: error
@typescript-eslint/restrict-template-expressions: error
@typescript-eslint/no-non-null-assertion: error
```

### Notable ESLint rules NOT enabled (opportunities)

```
@typescript-eslint/no-floating-promises          — uncaught async errors
@typescript-eslint/no-misused-promises           — promises in boolean/void contexts
@typescript-eslint/strict-boolean-expressions    — `if (str)` when `if (str !== "")` intended
@typescript-eslint/consistent-type-imports       — enforce `import type { }` for type-only imports
@typescript-eslint/switch-exhaustiveness-check   — catch missed union/enum branches
```

---

## Proposed Linters

### 1. ESLint Rule Additions

**What it catches**: Async bugs (unhandled promise rejections), type confusion, incomplete switch handling.

**Rules to add to `eslint.config.mjs`:**

```js
"@typescript-eslint/no-floating-promises": "error",
"@typescript-eslint/no-misused-promises": "error",
"@typescript-eslint/switch-exhaustiveness-check": "error",
"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
```

| Rule | Catches | False positive risk |
|------|---------|-------------------|
| `no-floating-promises` | Fire-and-forget async calls that silently swallow errors | Low — `.catch()` or `void` annotation fixes |
| `no-misused-promises` | `if (asyncFn())` always truthy, `arr.forEach(async ...)` | Low |
| `switch-exhaustiveness-check` | Missing cases in discriminated union switches (RPC dispatch, event handling) | None |
| `consistent-type-imports` | Ensures `import type` for type-only imports (smaller bundles, clearer intent) | None — auto-fixable |

**Complexity**: S — config change only
**Priority**: P1 — `no-floating-promises` and `switch-exhaustiveness-check` catch real bugs

---

### 2. Import Boundary Enforcement (`scripts/lint-imports.ts`)

**What it catches**: Cross-package imports that violate architectural boundaries.

**Current violations found**:
- CLI imports 16+ symbols from `@orka/daemon` (config, tracing, projects, log formatting) — partially by design since CLI hosts `orka serve`, but should be minimized

**Rules to enforce**:

| From → | Cannot import | Rationale |
|--------|---------------|-----------|
| `@orka/core` | `@orka/daemon`, `@orka/client`, `@orka/relay`, `@orka/dashboard` | Core is dependency-free |
| `@orka/relay` | `@orka/daemon`, `@orka/cli`, `@orka/dashboard` | Relay only depends on core |
| `@orka/client` | `@orka/daemon`, `@orka/cli`, `@orka/relay`, `@orka/dashboard` | Client is browser-safe |
| `@orka/dashboard` | `@orka/daemon`, `@orka/relay` | Dashboard uses core + client only |
| `@orka/cli` | `@orka/dashboard` | CLI never imports dashboard |

**Additional check**: `@orka/client` barrel must not re-export `node:fs`, `node:path`, or other Node-only APIs (currently clean).

**Implementation**: Custom script scanning `import` statements with package-name extraction. ~80 lines. Can also use `eslint-plugin-import` with `no-restricted-imports` per package, but a single script is simpler for monorepo enforcement.

**Complexity**: S
**Priority**: P2 — prevents architectural drift, catches violations early
**False positive risk**: Low — allowlist for known exceptions (CLI → daemon for `orka serve`)

---

### 3. Layer Separation Enforcement (`scripts/lint-layers.ts`)

**What it catches**: Leaking internal types, sensitive fields, and DB details across layer boundaries.

**Current violations found**:
- `SELECT s.*` in `listSessionItems()` (db.ts:372) and `listChildSessionItems()` (db.ts:761) — should specify columns for list queries

**Rules to enforce**:

| Check | Pattern | Current status |
|-------|---------|---------------|
| DB row types not exported | `*RowSchema` not in daemon barrel | Clean |
| `SELECT *` in list queries | Grep for `SELECT.*\*` in functions named `list*` | 2 violations |
| `env` not in responses | Grep for `env` in response construction | Clean (explicitly excluded with comment) |
| `logFile`/`rawLogFile` not in list responses | Check `SessionListResponse` shape | Clean |
| Domain types not in service returns | Check `OrkaService` method signatures | Clean |

**Implementation**: Custom script with regex-based checks on specific files. ~60 lines.

**Complexity**: S
**Priority**: P3 — violations are minor (SELECT * doesn't leak data due to DTO mapping)
**False positive risk**: Low — targeted file/function scanning

---

### 4. Protocol Consistency Checker (`scripts/lint-protocol.ts`)

**What it catches**: Mismatches between OrkaService interface, RPC dispatch, relay allowlist, and push channels.

**Current violations found**:

| Finding | Severity | Details |
|---------|----------|---------|
| 6 pairing methods missing from relay allowlist | High | `startPairing`, `pairWithNode`, `listPairedNodes`, `removePairedNode`, `connectNode`, `disconnectNode` will fail with "Method not allowed" when called through relay |
| Dead push channel `approval.requested` | Medium | Defined in `PushChannelSchema` but never emitted; dashboard doesn't subscribe |
| 2 RPC methods not in OrkaService | Low | `reportClientError`, `listClientErrors` handled in rpc-handler but not in interface (intentional escape hatch) |

**Rules to enforce**:

1. **RPC ↔ Service sync**: Every method in `OrkaService` interface must have a `case` in `rpc-handler.ts` dispatch switch, and vice versa.
2. **Relay allowlist sync**: Every method in `OrkaService` (except explicitly excluded local-only methods) must be in the relay's `ALLOWED_METHODS` set.
3. **Push channel liveness**: Every channel in `PushChannelSchema` must have at least one `pushHub.broadcast()` or `pushHub.send()` call somewhere in daemon code.
4. **Event type coverage**: Every variant in `KnownOrchestrationEventTypeSchema` must be emitted somewhere.

**Implementation**: AST-light script that extracts method names from the interface (regex on `service.ts`), case labels from `rpc-handler.ts`, allowed methods from relay, and push/broadcast calls from daemon. ~150 lines.

**Complexity**: M
**Priority**: P1 — the relay allowlist gap is a real bug (pairing methods silently fail through relay)
**False positive risk**: Low — comparing concrete string sets

---

### 5. Security Checks (`scripts/lint-security.ts`)

**What it catches**: Secrets exposure, crypto misuse, unsafe patterns.

**Current state**: Codebase is well-secured. No critical findings. Two minor timer issues.

**Rules to enforce**:

| Check | Pattern | Current status |
|-------|---------|---------------|
| `env` never serialized in responses | Grep for `env` in response mapping code | Clean |
| Private keys never logged | Grep for `.key` or `privateKey` near `console.log`/`logger` | Clean |
| Parameterized SQL only | Grep for template literals containing SQL keywords | Clean |
| `.unref()` on library timers | `setInterval`/`setTimeout` without `.unref()` in non-test code | 2 minor violations (codex-adapter:782, ws-transport:238,571) |
| No `eval()` or `Function()` | Standard security check | Clean |

**Implementation**: Targeted grep-based checks. ~80 lines.

**Complexity**: S
**Priority**: P3 — no critical findings, mostly hygiene enforcement
**False positive risk**: Medium for timer check (some timers intentionally block exit)

---

### 6. Test Quality Enforcement (`scripts/lint-tests.ts`)

**What it catches**: Empty tests, assertion-less test bodies, missing test files.

**Current violations found**:

| Finding | Location | Details |
|---------|----------|---------|
| 6 assertion-less tests | `relay/src/metering.test.ts` | Tests call methods but never `expect()` — they only verify "doesn't crash" |
| 49 source files without tests | Across all packages | Many are barrels/index files (acceptable), but some are substantial modules |

**Rules to enforce**:

1. **No assertion-less tests**: Every `test()` or `it()` body must contain at least one `expect`, `assert`, or `toThrow` call. Smoke tests that just verify no-crash should use `expect(() => fn()).not.toThrow()`.
2. **No `mock.module()`**: Already enforced by `lint-di.ts`.

**Not recommended**: Mandatory test file coverage check — too many false positives for barrels, type files, and composition roots. Better tracked via code review.

**Implementation**: Parse test files for `test(` / `it(` blocks, check for assertion presence. ~60 lines.

**Complexity**: S
**Priority**: P2 — assertion-less tests give false confidence
**False positive risk**: Low — clear pattern matching

---

### 7. Dead Code Detection (`scripts/lint-dead-code.ts`)

**What it catches**: Exported symbols never imported, dead event types, unused push channels.

**Current violations found**:
- Dead push channel: `approval.requested`
- Potential dead exports in barrel files (needs full scan)

**Rules to enforce**:

1. **Dead push channels**: Every `PushChannel` enum value must appear in a `pushHub.broadcast()` or `pushHub.send()` call (overlap with protocol checker).
2. **Dead event types**: Every orchestration event type must be emitted somewhere.
3. **Unused exported functions**: Exports from non-barrel files that are never imported anywhere.

**Implementation**: Export/import graph analysis. Can start simple (grep for export names across codebase) and grow. TypeScript's own `noUnusedLocals` already catches local dead code. ~100 lines for export analysis.

**Complexity**: M
**Priority**: P3 — low bug risk, cleanliness concern
**False positive risk**: Medium — exports may be used by external consumers or tests

---

### 8. Timer Hygiene Check (part of Security or standalone)

**What it catches**: `setInterval`/`setTimeout` in library code missing `.unref()`, which prevents clean process exit.

**Current violations**:
- `packages/daemon/src/adapters/codex-adapter.ts:782` — `setTimeout` without `.unref()`
- `packages/client/src/ws-transport.ts:238,571` — request/reconnect timers without `.unref()`

**Implementation**: Grep for `setInterval\(` and `setTimeout\(` in non-test files, check that the result is assigned and `.unref()` is called within 3 lines. ~40 lines.

**Complexity**: S
**Priority**: P3
**False positive risk**: Low — targeted check

---

## Implementation Priority

### Phase 1 — High impact, low effort (do first)

| Linter | Type | Catches | Effort |
|--------|------|---------|--------|
| ESLint rule additions | Config change | Floating promises, switch exhaustiveness | S |
| Protocol consistency checker | New script | Relay allowlist gaps (real bug), dead channels | M |

### Phase 2 — Architecture guardrails

| Linter | Type | Catches | Effort |
|--------|------|---------|--------|
| Import boundary enforcement | New script | Cross-package violations | S |
| Test quality enforcement | New script | Assertion-less tests | S |

### Phase 3 — Hygiene and hardening

| Linter | Type | Catches | Effort |
|--------|------|---------|--------|
| Layer separation enforcement | New script | SELECT *, type leaks | S |
| Security checks | New script | Timer .unref(), secrets patterns | S |
| Dead code detection | New script | Unused exports, dead events | M |

---

## Recommended CI Pipeline

```yaml
# .github/workflows/check.yml (or equivalent)
check:
  steps:
    # Phase 1: Fast checks (< 5s)
    - bun run lint:di          # DI policy
    - bun run lint:imports     # Import boundaries
    - bun run lint:protocol    # Wire consistency
    - bun run lint:tests       # Test quality
    - bun run lint:security    # Security patterns

    # Phase 2: Slow checks (30-60s)
    - bun run typecheck        # TypeScript strict
    - bun run lint             # ESLint (type-checked, slow)

    # Phase 3: Tests
    - bun test packages/       # Unit tests
    - bun test tests/e2e/      # E2E tests
```

**package.json additions:**
```json
{
  "scripts": {
    "lint:imports": "bun run scripts/lint-imports.ts",
    "lint:protocol": "bun run scripts/lint-protocol.ts",
    "lint:tests": "bun run scripts/lint-tests.ts",
    "lint:security": "bun run scripts/lint-security.ts",
    "check": "bun run typecheck && bun run lint && bun run lint:di && bun run lint:imports && bun run lint:protocol && bun run lint:tests && bun run lint:security"
  }
}
```

All custom linters follow the same pattern as `lint-di.ts`: scan files, collect violations, exit 0 (clean) or 1 (violations). Consistent output format for CI parsing.

---

## Summary of Current Violations Found

| Category | Violation | Severity | File(s) |
|----------|-----------|----------|---------|
| Protocol | 6 pairing methods missing from relay allowlist | High | `relay/src/index.ts` |
| Protocol | Dead push channel `approval.requested` | Medium | `core/src/push-protocol.ts` |
| Layer | `SELECT s.*` in list queries | Low | `daemon/src/db.ts:372,761` |
| Test | 6 assertion-less tests in metering | Low | `relay/src/metering.test.ts` |
| Timer | Missing `.unref()` on 3 timers | Low | `daemon/src/adapters/codex-adapter.ts:782`, `client/src/ws-transport.ts:238,571` |
| Import | CLI imports 16+ symbols from `@orka/daemon` | Info | `cli/src/index.ts` (partially by design) |
