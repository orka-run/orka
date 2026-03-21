import hljs from "highlight.js/lib/common";

export const HIGHLIGHT_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  htm: "xml",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function getHighlightLanguage(filePath: string): string | null {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : null;
  const language = extension ? HIGHLIGHT_LANGUAGE_BY_EXTENSION[extension] : null;

  if (!language) {
    return null;
  }

  return hljs.getLanguage(language) ? language : null;
}

export function highlightCode(content: string, filePath: string): string {
  const language = getHighlightLanguage(filePath);

  if (!language) {
    return escapeHtml(content);
  }

  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(content);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
