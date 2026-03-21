import { useCallback, useEffect, useRef } from "react";
import { X, Copy, Check } from "lucide-react";
import { useState } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("diff", diff);

interface FileContentModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  content: string;
  language?: string;
}

const DIFF_LINE_RE = /^[+-](?![+-])/;
const DIFF_HEADER_RE = /^(?:\+\+\+ |--- |@@)/;
const NUMBERED_LINE_RE = /^\s*(\d+)\s*[|:]\s?(.*)$/;

/** Guess a highlight.js language from a file path extension. */
function guessLanguage(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    css: "css",
    scss: "css",
    html: "html",
    xml: "xml",
    svg: "xml",
    py: "python",
    go: "go",
    rs: "rust",
    yml: "yaml",
    yaml: "yaml",
    sql: "sql",
    md: "markdown",
    toml: "yaml",
    dockerfile: "bash",
  };
  return ext ? map[ext] : undefined;
}

function isDiffContent(content: string): boolean {
  return content.split("\n").some((line) => DIFF_LINE_RE.test(line) || DIFF_HEADER_RE.test(line));
}

function diffLineClassName(line: string): string {
  if (DIFF_HEADER_RE.test(line)) return "bg-accent/10 text-accent-strong";
  if (/^[+](?![+])/.test(line)) return "bg-emerald-600/8 text-emerald-800";
  if (/^-(?!-)/.test(line)) return "bg-status-error/8 text-status-error";
  return "text-ink-secondary";
}

/** Strip line number prefixes (e.g. "  42| content") and return clean lines with original numbers. */
function parseNumberedLines(content: string): { lines: { number: string | null; content: string }[]; hasNumbers: boolean } {
  const rawLines = content.replace(/\n$/, "").split("\n");
  const parsed = rawLines.map((line) => {
    const m = line.match(NUMBERED_LINE_RE);
    return m ? { number: m[1] ?? null, content: m[2] ?? "" } : { number: null, content: line };
  });
  const hasNumbers = parsed.some((l) => l.number !== null);
  return { lines: parsed, hasNumbers };
}

export function FileContentModal({ open, onClose, title, content, language }: FileContentModalProps) {
  const [copied, setCopied] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API may not be available
    }
  }, [content]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const isDiff = isDiffContent(content);
  const lang = language ?? guessLanguage(title);

  // Determine display filename (last 2 path segments)
  const displayTitle = title.includes("/")
    ? title.split("/").slice(-2).join("/")
    : title;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-sm sm:items-center sm:px-4 sm:py-8"
    >
      <div className="flex max-h-full w-full flex-col bg-surface sm:max-h-[80vh] sm:max-w-4xl sm:rounded-sm sm:border sm:border-border">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span
            className="min-w-0 truncate font-mono text-[12px] font-medium text-ink"
            title={title}
          >
            {displayTitle}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-sm border border-border p-1 text-ink-muted transition hover:text-ink"
              title="Copy content"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-accent-strong" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-border p-1 text-ink-muted transition hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {isDiff ? (
            <DiffView content={content} />
          ) : (
            <HighlightedView content={content} {...(lang ? { language: lang } : {})} />
          )}
        </div>
      </div>
    </div>
  );
}

function DiffView({ content }: { content: string }) {
  const lines = content.replace(/\n$/, "").split("\n");

  return (
    <div className="font-mono text-[11px] leading-6">
      {lines.map((line, i) => (
        <div key={String(i)} className="grid grid-cols-[3rem_minmax(0,1fr)]">
          <span className="select-none border-r border-border px-2 py-0.5 text-right text-ink-muted">
            {i + 1}
          </span>
          <span className={`whitespace-pre-wrap break-all px-3 py-0.5 ${diffLineClassName(line)}`}>
            {line || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function HighlightedView({ content, language }: { content: string; language?: string }) {
  const { lines, hasNumbers } = parseNumberedLines(content);

  // Build raw text for highlighting (strip line number prefixes)
  const rawText = lines.map((l) => l.content).join("\n");

  let highlighted: string | null = null;
  if (language) {
    try {
      const result = hljs.highlight(rawText, { language });
      highlighted = result.value;
    } catch {
      // language not registered, fall back
    }
  }

  if (highlighted) {
    // Split highlighted HTML by newlines to pair with line numbers
    const htmlLines = highlighted.split("\n");

    return (
      <div className="font-mono text-[11px] leading-6">
        {htmlLines.map((htmlLine, i) => (
          <div key={String(i)} className="grid grid-cols-[3rem_minmax(0,1fr)]">
            <span className="select-none border-r border-border px-2 py-0.5 text-right text-ink-muted">
              {hasNumbers ? (lines[i]?.number ?? "") : i + 1}
            </span>
            <span
              className="whitespace-pre-wrap break-all px-3 py-0.5 text-ink-secondary"
              dangerouslySetInnerHTML={{ __html: htmlLine || " " }}
            />
          </div>
        ))}
      </div>
    );
  }

  // Plain text fallback with line numbers
  return (
    <div className="font-mono text-[11px] leading-6">
      {lines.map((line, i) => (
        <div key={String(i)} className="grid grid-cols-[3rem_minmax(0,1fr)]">
          <span className="select-none border-r border-border px-2 py-0.5 text-right text-ink-muted">
            {hasNumbers ? (line.number ?? "") : i + 1}
          </span>
          <span className="whitespace-pre-wrap break-all px-3 py-0.5 text-ink-secondary">
            {line.content || " "}
          </span>
        </div>
      ))}
    </div>
  );
}
