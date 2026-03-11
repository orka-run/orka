export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

const DIFF_GIT_PREFIX = "diff --git ";
const OLD_FILE_PREFIX = "--- ";
const NEW_FILE_PREFIX = "+++ ";
const BINARY_FILE_PREFIX = "Binary files ";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

interface HunkCursor {
  oldLineNumber: number;
  newLineNumber: number;
}

export function parseDiff(raw: string): DiffFile[] {
  if (!raw.trim()) {
    return [];
  }

  const files: DiffFile[] = [];
  const lines = raw.split(/\r?\n/);
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentCursor: HunkCursor | null = null;

  const pushCurrentFile = () => {
    if (currentFile) {
      files.push(currentFile);
    }
    currentFile = null;
    currentHunk = null;
    currentCursor = null;
  };

  const ensureCurrentFile = () => {
    if (!currentFile) {
      currentFile = { oldPath: "", newPath: "", hunks: [] };
    }
    return currentFile;
  };

  for (const line of lines) {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      pushCurrentFile();
      currentFile = parseDiffGitLine(line) ?? { oldPath: "", newPath: "", hunks: [] };
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/);
    if (hunkMatch) {
      currentHunk = { header: line, lines: [] };
      ensureCurrentFile().hunks.push(currentHunk);
      currentCursor = {
        oldLineNumber: Number(hunkMatch[1]),
        newLineNumber: Number(hunkMatch[3]),
      };
      continue;
    }

    if (currentHunk && currentCursor) {
      if (line === NO_NEWLINE_MARKER) {
        continue;
      }

      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.slice(1),
          newLineNumber: currentCursor.newLineNumber,
        });
        currentCursor.newLineNumber += 1;
        continue;
      }

      if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "remove",
          content: line.slice(1),
          oldLineNumber: currentCursor.oldLineNumber,
        });
        currentCursor.oldLineNumber += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "context",
          content: line.slice(1),
          oldLineNumber: currentCursor.oldLineNumber,
          newLineNumber: currentCursor.newLineNumber,
        });
        currentCursor.oldLineNumber += 1;
        currentCursor.newLineNumber += 1;
        continue;
      }
    }

    if (line.startsWith(OLD_FILE_PREFIX)) {
      ensureCurrentFile().oldPath = normalizeHeaderPath(line.slice(OLD_FILE_PREFIX.length));
      continue;
    }

    if (line.startsWith(NEW_FILE_PREFIX)) {
      ensureCurrentFile().newPath = normalizeHeaderPath(line.slice(NEW_FILE_PREFIX.length));
      continue;
    }

    if (line.startsWith(BINARY_FILE_PREFIX)) {
      const file = ensureCurrentFile();
      const binaryPaths = parseBinaryFileLine(line);
      if (binaryPaths) {
        file.oldPath = binaryPaths.oldPath;
        file.newPath = binaryPaths.newPath;
      }
      continue;
    }
  }

  pushCurrentFile();
  return files;
}

function parseDiffGitLine(line: string): DiffFile | null {
  const match = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
  if (!match) {
    return null;
  }

  const oldPath = match[1];
  const newPath = match[2];
  if (!oldPath || !newPath) {
    return null;
  }

  return {
    oldPath,
    newPath,
    hunks: [],
  };
}

function parseBinaryFileLine(line: string): Pick<DiffFile, "oldPath" | "newPath"> | null {
  const match = line.match(/^Binary files (.+) and (.+) differ$/);
  if (!match) {
    return null;
  }

  const oldPath = match[1];
  const newPath = match[2];
  if (!oldPath || !newPath) {
    return null;
  }

  return {
    oldPath: normalizeHeaderPath(oldPath),
    newPath: normalizeHeaderPath(newPath),
  };
}

function normalizeHeaderPath(path: string): string {
  const normalizedPath = path.replace(/^"|"$/g, "");

  if (normalizedPath === "/dev/null") {
    return normalizedPath;
  }

  if (normalizedPath.startsWith("a/") || normalizedPath.startsWith("b/")) {
    return normalizedPath.slice(2);
  }

  return normalizedPath;
}
