import { describe, expect, test } from "bun:test";
import { resolvePath, shortenPaths, getPathFromArgs } from "./pathUtils";

describe("resolvePath", () => {
  test("detects worktree paths and strips prefix", () => {
    const result = resolvePath(
      "/home/user/.orka/worktrees/sess-abc123/packages/daemon/src/db.ts",
      "/home/user/prj/orka",
    );
    expect(result.kind).toBe("worktree");
    expect(result.display).toBe("packages/daemon/src/db.ts");
    expect(result.full).toBe("/home/user/.orka/worktrees/sess-abc123/packages/daemon/src/db.ts");
  });

  test("detects project paths and strips prefix", () => {
    const result = resolvePath(
      "/home/user/prj/orka/packages/daemon/src/db.ts",
      "/home/user/prj/orka",
    );
    expect(result.kind).toBe("project");
    expect(result.display).toBe("packages/daemon/src/db.ts");
    expect(result.full).toBe("/home/user/prj/orka/packages/daemon/src/db.ts");
  });

  test("detects external paths", () => {
    const result = resolvePath("/usr/local/bin/some-tool", "/home/user/prj/orka");
    expect(result.kind).toBe("external");
    expect(result.display).toBe("/usr/local/bin/some-tool");
  });

  test("treats already-relative paths as worktree", () => {
    const result = resolvePath("packages/daemon/src/db.ts", "/home/user/prj/orka");
    expect(result.kind).toBe("worktree");
    expect(result.display).toBe("packages/daemon/src/db.ts");
  });

  test("handles exact projectPath match", () => {
    const result = resolvePath("/home/user/prj/orka", "/home/user/prj/orka");
    expect(result.kind).toBe("project");
    expect(result.display).toBe(".");
  });

  test("handles null projectPath", () => {
    const result = resolvePath("/home/user/prj/orka/file.ts", null);
    expect(result.kind).toBe("external");
    expect(result.display).toBe("/home/user/prj/orka/file.ts");
  });

  test("prioritizes worktree over project when path matches both", () => {
    // If projectPath happens to contain .orka/worktrees pattern, worktree wins
    const result = resolvePath(
      "/home/user/.orka/worktrees/sess-xyz/src/app.ts",
      "/home/user/.orka/worktrees/sess-xyz",
    );
    expect(result.kind).toBe("worktree");
    expect(result.display).toBe("src/app.ts");
  });
});

describe("shortenPaths", () => {
  test("strips worktree prefix from text", () => {
    const result = shortenPaths(
      "Read /home/user/.orka/worktrees/sess-abc123/packages/foo.ts",
      null,
    );
    expect(result).toBe("Read packages/foo.ts");
  });

  test("strips project path prefix from text", () => {
    const result = shortenPaths(
      "Read /home/user/prj/orka/packages/foo.ts",
      "/home/user/prj/orka",
    );
    expect(result).toBe("Read packages/foo.ts");
  });

  test("strips both worktree and project prefixes from mixed text", () => {
    const result = shortenPaths(
      "Compare /home/user/.orka/worktrees/sess-abc/a.ts with /home/user/prj/orka/b.ts",
      "/home/user/prj/orka",
    );
    expect(result).toBe("Compare a.ts with b.ts");
  });

  test("leaves external paths unchanged", () => {
    const result = shortenPaths("External /usr/local/bin/tool", "/home/user/prj");
    expect(result).toBe("External /usr/local/bin/tool");
  });

  test("handles empty text", () => {
    expect(shortenPaths("", null)).toBe("");
  });
});

describe("getPathFromArgs", () => {
  test("extracts file_path", () => {
    expect(getPathFromArgs({ file_path: "/home/user/file.ts" })).toBe("/home/user/file.ts");
  });

  test("extracts absolute path", () => {
    expect(getPathFromArgs({ path: "/home/user/dir" })).toBe("/home/user/dir");
  });

  test("ignores relative path key", () => {
    expect(getPathFromArgs({ path: "relative/path" })).toBeNull();
  });

  test("returns null for no args", () => {
    expect(getPathFromArgs(null)).toBeNull();
    expect(getPathFromArgs(undefined)).toBeNull();
    expect(getPathFromArgs({})).toBeNull();
  });
});
