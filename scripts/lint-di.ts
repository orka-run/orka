#!/usr/bin/env bun
/**
 * DI Linter — checks for dependency injection policy violations.
 *
 * Checks:
 * 1. `extends` in class declarations (except Error subclasses and React Component)
 * 2. `mock.module(` in test files (global module cache pollution)
 * 3. Singleton patterns: `let _xxx = null` followed by `export function get`
 *
 * Usage:
 *   bun run scripts/lint-di.ts
 *   bun run lint:di
 *
 * Exit code 0 = clean, 1 = violations found.
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const violations: Violation[] = [];

// Collect all .ts/.tsx files under packages/, excluding node_modules
const glob = new Glob("**/*.{ts,tsx}");
const files: string[] = [];
for (const match of glob.scanSync({ cwd: PACKAGES_DIR })) {
  if (match.includes("node_modules")) continue;
  files.push(join(PACKAGES_DIR, match));
}

for (const file of files) {
  const relPath = relative(ROOT, file);
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  const isTest = file.endsWith(".test.ts") || file.endsWith(".test.tsx");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Rule 1: class inheritance (non-test files only)
    if (!isTest) {
      const classMatch = line.match(/\bclass\s+(\w+)\s+extends\s+(\w+)/);
      if (classMatch) {
        const [, className, parentClass] = classMatch;
        // Allow: Error subclasses, React Component/PureComponent
        const allowed = /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|Component|PureComponent)$/.test(parentClass!);
        if (!allowed) {
          violations.push({
            file: relPath,
            line: lineNum,
            rule: "no-extends",
            text: `class ${className} extends ${parentClass} — use composition instead`,
          });
        }
      }
    }

    // Rule 2: mock.module() in test files
    if (isTest && line.includes("mock.module(")) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: "no-mock-module",
        text: "mock.module() poisons global module cache — use DI (factory params) instead",
      });
    }

    // Rule 3: Singleton pattern detection (non-test files only)
    if (!isTest) {
      const singletonMatch = line.match(/^(?:export\s+)?let\s+_\w+.*(?::\s*\w+\s*\|\s*null\s*=\s*null|=\s*null)/);
      if (singletonMatch) {
        // Look ahead for `export function get` within next 10 lines
        for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
          if (/^export\s+function\s+get\w*\s*\(/.test(lines[j]!)) {
            violations.push({
              file: relPath,
              line: lineNum,
              rule: "no-singleton",
              text: "Module-level singleton with lazy getter — create at composition root instead",
            });
            break;
          }
        }
      }
    }
  }
}

// Report
if (violations.length === 0) {
  console.log("lint:di — no violations found");
  process.exit(0);
} else {
  console.log(`lint:di — ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
  }
  console.log("");
  process.exit(1);
}
