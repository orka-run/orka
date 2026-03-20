#!/usr/bin/env bun
/**
 * Test Performance Linter — checks for test performance and isolation violations.
 *
 * Rules:
 * 1. `no-disk-sqlite` — no `openDb(` calls in tests (use `openTestDb()` for in-memory)
 * 2. `no-long-sleep` — no `Bun.sleep(N)` or `setTimeout(_, N)` where N > 200ms
 * 3. `no-bare-env-mutation` — no `process.env["ORKA_HOME"] =` or `process.env["ORKA_RELAY_DATA"] =`
 *
 * Usage:
 *   bun run scripts/lint-tests.ts
 *   bun run lint:tests
 *
 * Exit code 0 = clean, 1 = violations found.
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

interface AllowlistEntry {
  file: string;
  rule: string;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: "packages/daemon/src/server.test.ts",
    rule: "no-disk-sqlite",
    reason: "needs disk DB for trace file testing",
  },
  {
    file: "tests/e2e/protocol/noise-relay.e2e.test.ts",
    rule: "no-long-sleep",
    reason: "1000ms idle persistence test requires real delay",
  },
  {
    file: "packages/daemon/src/server.test.ts",
    rule: "no-bare-env-mutation",
    reason: "server test needs ORKA_HOME for daemon startup",
  },
  // E2E tests: TestShellAdapter reads ORKA_HOME for script isolation
  {
    file: "tests/e2e/protocol/noise-advanced.e2e.test.ts",
    rule: "no-bare-env-mutation",
    reason: "TestShellAdapter reads ORKA_HOME for provider-scripts isolation",
  },
  {
    file: "tests/e2e/protocol/session-lifecycle.e2e.test.ts",
    rule: "no-bare-env-mutation",
    reason: "TestShellAdapter reads ORKA_HOME for provider-scripts isolation",
  },
  {
    file: "tests/e2e/protocol/noise-transport.e2e.test.ts",
    rule: "no-bare-env-mutation",
    reason: "TestShellAdapter reads ORKA_HOME for provider-scripts isolation",
  },
];

function isAllowlisted(relPath: string, rule: string): boolean {
  return ALLOWLIST.some((a) => a.file === relPath && a.rule === rule);
}

function importsPollingHelper(content: string): boolean {
  return /from\s+["'][^"']*helpers\/polling["']/.test(content);
}

const violations: Violation[] = [];

// Collect all *.test.ts files under packages/ and tests/, excluding node_modules
const scanDirs = [join(ROOT, "packages"), join(ROOT, "tests")];
const glob = new Glob("**/*.test.ts");
const files: string[] = [];

for (const dir of scanDirs) {
  for (const match of glob.scanSync({ cwd: dir })) {
    if (match.includes("node_modules")) continue;
    files.push(join(dir, match));
  }
}

for (const file of files) {
  const relPath = relative(ROOT, file);
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  const usesPollingHelper = importsPollingHelper(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Rule 1: no-disk-sqlite — flag openDb( calls
    if (/\bopenDb\(/.test(line) && !isAllowlisted(relPath, "no-disk-sqlite")) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: "no-disk-sqlite",
        text: "openDb() creates disk SQLite — use openTestDb() (in-memory) instead",
      });
    }

    // Rule 2: no-long-sleep — flag Bun.sleep(N) or setTimeout(_, N) where N > 200
    if (!isAllowlisted(relPath, "no-long-sleep")) {
      // Match Bun.sleep(N) where N > 200
      const bunSleepMatch = line.match(/Bun\.sleep\(\s*(\d[\d_]*)\s*\)/);
      if (bunSleepMatch) {
        const ms = parseInt(bunSleepMatch[1]!.replace(/_/g, ""), 10);
        if (ms > 200) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: "no-long-sleep",
            text: `Bun.sleep(${ms}) exceeds 200ms — use shorter waits or event-driven synchronization`,
          });
        }
      }

      // Match setTimeout(_, N) where N > 200
      const setTimeoutMatch = line.match(/setTimeout\([^,]+,\s*(\d[\d_]*)\s*\)/);
      if (setTimeoutMatch) {
        const ms = parseInt(setTimeoutMatch[1]!.replace(/_/g, ""), 10);
        if (ms > 200) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: "no-long-sleep",
            text: `setTimeout with ${ms}ms delay exceeds 200ms — use shorter waits or event-driven synchronization`,
          });
        }
      }
    }

    // Rule 3: no-bare-env-mutation — flag process.env["ORKA_HOME"] = or process.env["ORKA_RELAY_DATA"] =
    if (/process\.env\["ORKA_HOME"\]\s*=|process\.env\["ORKA_RELAY_DATA"\]\s*=/.test(line)) {
      // Allowed in server.test.ts and files that import from helpers/polling
      if (!isAllowlisted(relPath, "no-bare-env-mutation") && !usesPollingHelper) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: "no-bare-env-mutation",
          text: "bare process.env mutation — pass paths via DI (function parameters) instead",
        });
      }
    }
  }
}

// Report
if (violations.length === 0) {
  console.log("lint:tests — no violations found");
  process.exit(0);
} else {
  console.log(`lint:tests — ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
  }
  console.log("");
  process.exit(1);
}
