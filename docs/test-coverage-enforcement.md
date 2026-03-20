# Test Coverage Enforcement

**Date:** 2026-03-20
**Status:** Proposal
**Related:** [test-coverage-audit.md](./test-coverage-audit.md), [linting-strategy.md](./linting-strategy.md)

## Current State

- **Test runner:** `bun test` (Bun 1.3.10)
- **Coverage tooling:** None configured
- **Pre-commit hook:** `bun run typecheck` only (via lefthook)
- **CI:** None (no GitHub Actions)
- **Coverage reporting:** None

Bun 1.3.10 supports `--coverage` natively with text and lcov reporters. No external tooling (c8, istanbul, nyc) is needed.

## Tool Evaluation

### bun test --coverage (Recommended)

Built-in. Produces a text table and/or lcov file.

```bash
bun test --coverage packages/                       # text table to stdout
bun test --coverage --coverage-reporter=lcov packages/  # lcov.info in coverage/
bun test --coverage --coverage-reporter=text,lcov packages/  # both
```

**Pros:**
- Zero dependencies, ships with bun
- Reports % Funcs, % Lines, uncovered line numbers
- lcov output integrates with any standard coverage viewer (VS Code, Codecov, etc.)

**Cons:**
- No built-in threshold enforcement (no `--coverage-threshold` flag)
- Reports all transitive imports, not just tested files — inflates the table
- No built-in "changed files only" mode

**Verdict:** Use this as the coverage engine. Add a thin script for threshold enforcement.

### c8

V8 coverage wrapper. Can enforce thresholds natively (`c8 --lines 80 bun test`).

**Pros:** Built-in threshold enforcement, mature tooling.
**Cons:** Extra dependency, designed for Node (V8). Bun uses JavaScriptCore, not V8. **c8 will not work with bun.**

**Verdict:** Not compatible.

### istanbul / nyc

Instrumentation-based coverage. Requires source transformation.

**Verdict:** Too heavy. Bun's native coverage is simpler and faster. Skip.

### Mutation testing (Stryker)

Modifies source code and re-runs tests to find weak assertions. Finds tests that "pass" but don't actually verify behavior.

**Pros:** Catches assertion-less tests, weak assertions, dead test code.
**Cons:** Very slow (reruns tests per mutation), complex setup, poor bun support.

**Verdict:** Not now. The assertion-less test linter in [linting-strategy.md](./linting-strategy.md) (lint:tests) catches the most common case at near-zero cost. Revisit when test suite is more mature.

### Custom lint rule for test coverage

A `scripts/lint-coverage.ts` script that parses bun's lcov output and enforces thresholds.

**Verdict:** This is the recommended approach. ~60 lines, no dependencies.

## Recommended Approach

### 1. bunfig.toml — Enable coverage reporting

```toml
[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
```

This makes `bun test` always produce coverage. The text table prints to stdout; lcov goes to `coverage/lcov.info`. Add `coverage/` to `.gitignore`.

**Alternative:** Don't enable by default (slows tests ~20%), use explicit `bun test --coverage` in scripts only. This is better for developer experience — coverage on-demand, not on every `bun test`.

**Recommendation:** Don't enable by default. Add a `test:coverage` script instead.

### 2. package.json scripts

```json
{
  "scripts": {
    "test": "bun test packages/",
    "test:coverage": "bun test --coverage --coverage-reporter=text,lcov packages/",
    "test:e2e": "bun test tests/e2e/",
    "coverage:check": "bun run test:coverage && bun run scripts/check-coverage.ts"
  }
}
```

### 3. Threshold enforcement script

`scripts/check-coverage.ts` — parses the lcov output and fails if thresholds aren't met.

```typescript
import { readFileSync } from "node:fs";

const LCOV_PATH = "coverage/lcov.info";
const THRESHOLDS = { lines: 50, functions: 50 };

interface FileCoverage {
  file: string;
  linesHit: number;
  linesTotal: number;
  funcsHit: number;
  funcsTotal: number;
}

function parseLcov(content: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: Partial<FileCoverage> = {};

  for (const line of content.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3), linesHit: 0, linesTotal: 0, funcsHit: 0, funcsTotal: 0 };
    } else if (line.startsWith("LH:")) {
      current.linesHit = parseInt(line.slice(3));
    } else if (line.startsWith("LF:")) {
      current.linesTotal = parseInt(line.slice(3));
    } else if (line.startsWith("FNH:")) {
      current.funcsHit = parseInt(line.slice(4));
    } else if (line.startsWith("FNF:")) {
      current.funcsTotal = parseInt(line.slice(4));
    } else if (line === "end_of_record" && current.file) {
      files.push(current as FileCoverage);
      current = {};
    }
  }
  return files;
}

function pct(hit: number, total: number): number {
  return total === 0 ? 100 : Math.round((hit / total) * 10000) / 100;
}

const lcov = readFileSync(LCOV_PATH, "utf-8");
const files = parseLcov(lcov);

// Aggregate
const totals = files.reduce(
  (acc, f) => ({
    linesHit: acc.linesHit + f.linesHit,
    linesTotal: acc.linesTotal + f.linesTotal,
    funcsHit: acc.funcsHit + f.funcsHit,
    funcsTotal: acc.funcsTotal + f.funcsTotal,
  }),
  { linesHit: 0, linesTotal: 0, funcsHit: 0, funcsTotal: 0 },
);

const linePct = pct(totals.linesHit, totals.linesTotal);
const funcPct = pct(totals.funcsHit, totals.funcsTotal);

console.log(`\nCoverage: ${linePct}% lines, ${funcPct}% functions\n`);

let failed = false;
if (linePct < THRESHOLDS.lines) {
  console.error(`FAIL: Line coverage ${linePct}% < ${THRESHOLDS.lines}% threshold`);
  failed = true;
}
if (funcPct < THRESHOLDS.functions) {
  console.error(`FAIL: Function coverage ${funcPct}% < ${THRESHOLDS.functions}% threshold`);
  failed = true;
}

if (failed) process.exit(1);
else console.log("Coverage thresholds met.");
```

### 4. Coverage diff — changed files only

Global coverage numbers are noisy for a project with many untested legacy modules. A coverage diff check is more useful: **new/changed code must meet a higher bar than the global average.**

**Approach:** Compare `git diff --name-only` against lcov per-file data. Only enforce thresholds on files that changed in the current branch.

```typescript
// scripts/check-coverage-diff.ts
// Usage: bun run scripts/check-coverage-diff.ts [base-branch]
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DIFF_THRESHOLD = { lines: 70, functions: 70 };
const base = process.argv[2] || "master";

// Get changed .ts files (not test files, not type-only)
const changed = execSync(`git diff --name-only ${base}...HEAD -- '*.ts'`)
  .toString()
  .split("\n")
  .filter((f) => f && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));

if (changed.length === 0) {
  console.log("No changed .ts files — skipping coverage diff check.");
  process.exit(0);
}

// Parse lcov (same function as above)
const lcov = readFileSync("coverage/lcov.info", "utf-8");
// ... parse and filter to changed files ...
// ... enforce DIFF_THRESHOLD on each changed file ...
```

This is the most impactful check: it ensures new code ships with tests without penalizing existing gaps.

### 5. Lefthook integration

**Pre-commit: Do NOT add coverage checks.** Tests are too slow (~1-5s for unit, 30s+ for E2E). Pre-commit should stay fast (typecheck only, <5s). Slow hooks make developers skip them (`--no-verify`).

**Pre-push: Add coverage check.** Pre-push runs less frequently and developers expect it to take longer.

```yaml
# lefthook.yml
pre-commit:
  commands:
    typecheck:
      run: bun run typecheck

pre-push:
  commands:
    test:
      run: bun test packages/
    coverage-diff:
      run: bun test --coverage --coverage-reporter=lcov packages/ && bun run scripts/check-coverage-diff.ts
```

**Trade-off:** Pre-push coverage adds ~10-30s. This is acceptable since pushes are infrequent. If it becomes annoying, move to CI-only.

### 6. CI integration (future)

When GitHub Actions (or equivalent) is added:

```yaml
# .github/workflows/check.yml
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run test:coverage
      - run: bun run scripts/check-coverage.ts          # Global threshold
      - run: bun run scripts/check-coverage-diff.ts      # Diff threshold
      # Optional: upload lcov to Codecov/Coveralls
      - uses: codecov/codecov-action@v4
        with:
          files: coverage/lcov.info
```

## Threshold Recommendations

### What threshold?

| Context | Lines | Functions | Rationale |
|---------|-------|-----------|-----------|
| **Global (all files)** | 50% | 50% | Low bar — many modules have zero tests today. Ratchet up as coverage improves. |
| **Changed files (diff)** | 70% | 70% | Higher bar for new/modified code. Prevents coverage from getting worse. |
| **Critical paths** | 80% | 80% | Optional: tag critical modules (crypto, auth, state machine) with higher thresholds. |

### Block or warn?

| Hook/Gate | Action | Rationale |
|-----------|--------|-----------|
| **Pre-commit** | Neither | Too slow. Don't add coverage to pre-commit. |
| **Pre-push** | **Warn** (exit 0) | Print coverage report but don't block push. Developers may have valid reasons to push uncovered code (WIP, refactoring). |
| **CI** | **Block** (exit 1) | CI is the gate of record. Failed coverage = failed build = can't merge. |

Start with warn everywhere, promote to block in CI once the baseline is established.

### Ratcheting strategy

Instead of picking a fixed number, use a ratchet: coverage can only go up.

1. Run `bun run test:coverage` on master, record the baseline in a `.coverage-baseline` file
2. On each PR, compare current coverage to baseline
3. Fail if coverage decreased by more than 1% (allows small fluctuations from refactoring)
4. After merge, update the baseline

This avoids the "what threshold?" debate entirely — the threshold is "at least as good as before."

## Decision Matrix

| Approach | Effort | Impact | Recommendation |
|----------|--------|--------|----------------|
| `bun test --coverage` in scripts | S | Low — just reporting | **Do now** |
| `scripts/check-coverage.ts` (global threshold) | S | Medium — prevents regression | **Do now** |
| `scripts/check-coverage-diff.ts` (changed files) | M | High — enforces new-code quality | **Do soon** |
| Pre-push hook (warn) | S | Medium — developer feedback loop | **Do soon** |
| CI coverage gate (block) | S | High — authoritative gate | **Do when CI exists** |
| Coverage ratchet | M | High — auto-tightening | **Do when CI exists** |
| Mutation testing | L | Medium — diminishing returns | **Skip for now** |
| Per-file threshold config | M | Low — over-engineering | **Skip** |

## Implementation Plan

### Phase 1: Visibility (immediate)

1. Add `test:coverage` script to package.json
2. Add `coverage/` to `.gitignore`
3. Run once to establish baseline numbers

### Phase 2: Enforcement (this week)

4. Write `scripts/check-coverage.ts` — global threshold (50% lines/functions)
5. Write `scripts/check-coverage-diff.ts` — diff threshold (70% lines/functions on changed files)
6. Add `coverage:check` script to package.json
7. Add pre-push hook to lefthook.yml (warn mode)

### Phase 3: Gating (when CI lands)

8. Add coverage step to CI workflow
9. Switch CI from warn to block
10. Implement ratchet (`.coverage-baseline` file, CI comparison)
11. Add Codecov/Coveralls badge to README

## Notes

- Bun's coverage reports all transitive imports. A test file for `rate-limiter.ts` will also show coverage for `tracing.ts`, `db.ts`, etc. This inflates the report. The lcov parser script should optionally filter to `packages/*/src/**` and exclude test files.
- Coverage does not measure test quality. A file can have 100% line coverage with zero meaningful assertions. Pair coverage enforcement with the assertion-less test linter from [linting-strategy.md](./linting-strategy.md).
- E2E tests (`tests/e2e/`) provide the most realistic coverage but are slow. Run coverage on unit tests only for fast feedback; include E2E in CI for authoritative numbers.
