import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

interface TraceTarget {
  id: string;
  file: string;
  line: number;
  kind: "function" | "method";
  className?: string;
  name: string;
  body: string;
}

const TRACE_SKIP_ALLOWLIST = new Set([
  "adapters/claude-adapter.ts:ClaudeCodeAdapter.replayRawLog",
  "adapters/claude-adapter.ts:ClaudeCodeAdapter.respondToRequest",
  "adapters/claude-adapter.ts:ClaudeCodeAdapter.sendTurn",
  "adapters/codex-adapter.ts:CodexAdapter.replayRawLog",
  "daemon-context.ts:createDaemonContext",
  "db.ts:migrateDb",
  "migrations/001_initial.ts:up",
  "migrations/002_backfill_workspaces.ts:up",
  "rpc-handler.ts:handleRpcRequest",
  "tracing.ts:shutdownTracing",
  "tracing.ts:withSpan",
]);

const SPAN_WRAPPER_RE = /\bwithSpan(?:Sync)?\s*\(/;

describe("daemon trace coverage", () => {
  test("exported async daemon APIs stay wrapped in tracing spans", () => {
    const srcDir = import.meta.dir;
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: srcDir }))
      .filter((file) => !file.endsWith(".test.ts"))
      .sort();

    const untraced = files
      .flatMap((file) => collectTraceTargets(readFileSync(join(srcDir, file), "utf8"), file))
      .filter((target) => !TRACE_SKIP_ALLOWLIST.has(target.id))
      .filter((target) => !SPAN_WRAPPER_RE.test(target.body))
      .map((target) => `${target.file}:${target.line} ${target.kind} ${formatTarget(target)}`);

    if (untraced.length > 0) {
      throw new Error(
        [
          "Found exported async daemon APIs without a direct withSpan/withSpanSync wrapper:",
          ...untraced.map((entry) => `- ${entry}`),
        ].join("\n"),
      );
    }
  });
});

function collectTraceTargets(source: string, file: string): TraceTarget[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return [
    ...findExportedAsyncFunctions(sourceFile),
    ...findExportedAsyncClassMethods(sourceFile),
  ];
}

function findExportedAsyncFunctions(sourceFile: ts.SourceFile): TraceTarget[] {
  const targets: TraceTarget[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.name || !statement.body || !hasModifier(statement, ts.SyntaxKind.ExportKeyword) || !isAsync(statement)) {
        continue;
      }

      targets.push({
        id: `${sourceFile.fileName}:${statement.name.text}`,
        file: sourceFile.fileName,
        line: getLineNumber(sourceFile, statement),
        kind: "function",
        name: statement.name.text,
        body: statement.body.getText(sourceFile),
      });
      continue;
    }

    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !isAsyncInitializer(declaration.initializer)) {
        continue;
      }

      const body = ts.isBlock(declaration.initializer.body) ? declaration.initializer.body.getText(sourceFile) : "";
      targets.push({
        id: `${sourceFile.fileName}:${declaration.name.text}`,
        file: sourceFile.fileName,
        line: getLineNumber(sourceFile, declaration),
        kind: "function",
        name: declaration.name.text,
        body,
      });
    }
  }

  return targets;
}

function findExportedAsyncClassMethods(sourceFile: ts.SourceFile): TraceTarget[] {
  const targets: TraceTarget[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name) || !member.body) {
        continue;
      }

      if (!isAsync(member) || hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) {
        continue;
      }

      const className = statement.name.text;
      targets.push({
        id: `${sourceFile.fileName}:${className}.${member.name.text}`,
        file: sourceFile.fileName,
        line: getLineNumber(sourceFile, member),
        kind: "method",
        className,
        name: member.name.text,
        body: member.body.getText(sourceFile),
      });
    }
  }

  return targets;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier: ts.Modifier) => modifier.kind === kind) ?? false;
}

function isAsync(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function isAsyncInitializer(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && isAsync(node);
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function formatTarget(target: TraceTarget): string {
  return target.className ? `${target.className}.${target.name}` : target.name;
}
