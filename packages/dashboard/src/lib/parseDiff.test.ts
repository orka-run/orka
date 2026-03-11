import { describe, expect, test } from "bun:test";
import { parseDiff } from "./parseDiff";

describe("parseDiff", () => {
  test("parses an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff(" \n")).toEqual([]);
  });

  test("parses a single file with additions", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index e69de29..1111111 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -0,0 +1,2 @@",
      "+const ready = true;",
      '+console.log("ready");',
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      {
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        hunks: [
          {
            header: "@@ -0,0 +1,2 @@",
            lines: [
              { type: "add", content: "const ready = true;", newLineNumber: 1 },
              { type: "add", content: 'console.log("ready");', newLineNumber: 2 },
            ],
          },
        ],
      },
    ]);
  });

  test("parses removals and context lines with line numbers", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,2 @@",
      " const keep = true;",
      '-console.log("remove");',
      ' console.log("stay");',
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      {
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        hunks: [
          {
            header: "@@ -1,3 +1,2 @@",
            lines: [
              {
                type: "context",
                content: "const keep = true;",
                oldLineNumber: 1,
                newLineNumber: 1,
              },
              {
                type: "remove",
                content: 'console.log("remove");',
                oldLineNumber: 2,
              },
              {
                type: "context",
                content: 'console.log("stay");',
                oldLineNumber: 3,
                newLineNumber: 2,
              },
            ],
          },
        ],
      },
    ]);
  });

  test("parses multiple files", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      '-console.log("old");',
      '+console.log("new");',
      "diff --git a/src/utils.ts b/src/utils.ts",
      "--- a/src/utils.ts",
      "+++ b/src/utils.ts",
      "@@ -1,0 +1 @@",
      "+export const value = 1;",
    ].join("\n");

    const files = parseDiff(diff);

    expect(files).toHaveLength(2);
    expect(files[0]?.newPath).toBe("src/app.ts");
    expect(files[1]?.newPath).toBe("src/utils.ts");
  });

  test("handles binary file diffs", () => {
    const diff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      {
        oldPath: "assets/logo.png",
        newPath: "assets/logo.png",
        hunks: [],
      },
    ]);
  });

  test("keeps hunk lines that start with file-header prefixes", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      " const marker = true;",
      "----removed header-like line",
      "++++added header-like line",
    ].join("\n");

    expect(parseDiff(diff)[0]?.hunks[0]?.lines).toEqual([
      {
        type: "context",
        content: "const marker = true;",
        oldLineNumber: 1,
        newLineNumber: 1,
      },
      {
        type: "remove",
        content: "---removed header-like line",
        oldLineNumber: 2,
      },
      {
        type: "add",
        content: "+++added header-like line",
        newLineNumber: 2,
      },
    ]);
  });

  test("handles new and deleted file headers", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export const created = true;",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const removed = true;",
    ].join("\n");

    expect(parseDiff(diff)).toEqual([
      {
        oldPath: "/dev/null",
        newPath: "src/new.ts",
        hunks: [
          {
            header: "@@ -0,0 +1 @@",
            lines: [
              {
                type: "add",
                content: "export const created = true;",
                newLineNumber: 1,
              },
            ],
          },
        ],
      },
      {
        oldPath: "src/old.ts",
        newPath: "/dev/null",
        hunks: [
          {
            header: "@@ -1 +0,0 @@",
            lines: [
              {
                type: "remove",
                content: "export const removed = true;",
                oldLineNumber: 1,
              },
            ],
          },
        ],
      },
    ]);
  });
});
