import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { resolvePath, getPathFromArgs, type ResolvedPath } from "../lib/pathUtils";
import { highlightCode } from "../lib/syntaxHighlight";
import { FileContentModal } from "./FileContentModal";
import { MarkdownContent } from "./MarkdownContent";

interface ToolCallDetailsProps {
  title: string;
  details: string[];
  args?: unknown;
  projectPath?: string | null;
}

type ParsedDetail =
  | {
      kind: "read";
      label: string;
      path?: string;
      content: string;
    }
  | {
      kind: "edit";
      label: string;
      path?: string;
      content: string;
    }
  | {
      kind: "command";
      label: string;
      command: string;
      output: string;
    }
  | {
      kind: "search";
      label: string;
      query: string;
      results: string[];
    }
  | {
      kind: "default";
      label: string;
      content: string;
    };

const READ_TITLE_RE = /\b(read|cat)\b/i;
const EDIT_TITLE_RE = /\b(edit|write|rewrite|replace|patch|apply[_ -]?patch|file change)\b/i;
const COMMAND_TITLE_RE = /\b(bash|command|shell|terminal|run)\b/i;
const SEARCH_TITLE_RE = /\b(grep|glob|search|rg|ripgrep|find)\b/i;
const NUMBERED_LINE_RE = /^\s*(\d+)\s*([|:])\s?(.*)$/;
const SEARCH_RESULT_RE = /^(.+?):(\d+)(?::(\d+))?:(.*)$/;
const COMMON_COMMAND_RE =
  /^(?:\$ |>|bun\b|npm\b|pnpm\b|yarn\b|node\b|python(?:3)?\b|bash\b|sh\b|git\b|rg\b|grep\b|find\b|ls\b|cat\b|sed\b|awk\b|make\b|cargo\b|go\b|uv\b|pytest\b|docker\b|kubectl\b|terraform\b)/i;

export function ToolCallDetails({ title, details, args, projectPath }: ToolCallDetailsProps) {
  const argsRecord = (args != null && typeof args === "object" ? args : null) as Record<string, unknown> | null;
  const hasArgs = argsRecord != null && Object.keys(argsRecord).length > 0;

  // Synthesize a diff from Edit args (old_string + new_string) so the user
  // sees a visual diff instead of raw key-value pairs.
  const editDiff = synthesizeEditDiff(argsRecord);
  // Filter old_string/new_string out of ArgsDetail when we have a synthetic diff
  const filteredArgs = editDiff && argsRecord
    ? Object.fromEntries(Object.entries(argsRecord).filter(([k]) => k !== "old_string" && k !== "new_string"))
    : argsRecord;
  const hasFilteredArgs = filteredArgs != null && Object.keys(filteredArgs).length > 0;

  if (details.length === 0 && !hasArgs && !editDiff) {
    return (
      <div className="rounded-sm border border-border bg-surface-alt px-2 py-1.5 font-mono text-[11px] text-ink-muted">
        No tool details recorded.
      </div>
    );
  }

  // Resolve the primary file path from args for indicator/tooltip in PathHeader
  const absolutePath = getPathFromArgs(args);
  const resolved = absolutePath ? resolvePath(absolutePath, projectPath ?? null) : null;

  // When we have a synthetic diff, filter out details that are just the file path
  // (adapter sets detail = file path for Edit tools, which is redundant)
  const filteredDetails = editDiff
    ? details.filter((d) => {
        const trimmed = d.trim();
        const diffPath = "path" in editDiff ? editDiff.path : undefined;
        return trimmed !== diffPath && !isLikelyFilePath(trimmed);
      })
    : details;
  const parsedDetails = filteredDetails.map((detail, index) => parseDetail(title, detail, index));

  // Inject synthetic edit diff as the primary detail
  if (editDiff) {
    parsedDetails.unshift(editDiff);
  }

  return (
    <div className="space-y-2">
      {hasFilteredArgs ? <ArgsDetail args={filteredArgs} {...(projectPath !== undefined ? { projectPath } : {})} /> : null}
      {parsedDetails.map((detail, index) => (
        <ExpandableDetail
          key={`${detail.kind}-${detail.label}-${String(index)}`}
          detail={detail}
          defaultOpen={index === 0}
          resolved={resolved}
          {...(projectPath !== undefined ? { projectPath } : {})}
        />
      ))}
    </div>
  );
}

/** Wraps a single parsed detail with an expand-to-modal button. */
function ExpandableDetail({
  detail,
  defaultOpen,
  resolved,
  projectPath,
}: {
  detail: ParsedDetail;
  defaultOpen: boolean;
  resolved?: ResolvedPath | null;
  projectPath?: string | null;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const modalTitle = detail.kind === "command"
    ? (detail as Extract<ParsedDetail, { kind: "command" }>).command
    : ("path" in detail && detail.path) || detail.label;

  const modalContent = detail.kind === "command"
    ? (detail as Extract<ParsedDetail, { kind: "command" }>).output
    : detail.kind === "search"
      ? (detail as Extract<ParsedDetail, { kind: "search" }>).results.join("\n")
      : detail.content;

  return (
    <>
      <details
        open={defaultOpen}
        className="overflow-hidden rounded-sm border border-border bg-surface"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
          <span className="truncate font-mono text-[11px] text-ink-secondary">{detail.label}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setModalOpen(true);
              }}
              className="rounded-sm p-0.5 text-ink-muted transition hover:text-ink"
              title="Expand in modal"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              {detail.kind === "default" ? "output" : detail.kind}
            </span>
          </span>
        </summary>
        <div className="border-t border-border">
          {detail.kind === "read" ? <ReadDetail detail={detail} {...(resolved !== undefined ? { resolved } : {})} /> : null}
          {detail.kind === "edit" ? <EditDetail detail={detail} {...(resolved !== undefined ? { resolved } : {})} /> : null}
          {detail.kind === "command" ? <CommandDetail detail={detail} /> : null}
          {detail.kind === "search" ? <SearchDetail detail={detail} {...(projectPath !== undefined ? { projectPath } : {})} /> : null}
          {detail.kind === "default" ? <DefaultDetail detail={detail} /> : null}
        </div>
      </details>
      <FileContentModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={modalTitle}
        content={modalContent}
      />
    </>
  );
}

function ReadDetail({ detail, resolved }: { detail: Extract<ParsedDetail, { kind: "read" }>; resolved?: ResolvedPath | null }) {
  return (
    <div>
      {detail.path ? <PathHeader path={detail.path} {...(resolved !== undefined ? { resolved } : {})} /> : null}
      {detail.content.trim() ? (
        <CodeBlock content={detail.content} {...(detail.path ? { filePath: detail.path } : {})} />
      ) : (
        <EmptyState message="No file content captured." />
      )}
    </div>
  );
}

function EditDetail({ detail, resolved }: { detail: Extract<ParsedDetail, { kind: "edit" }>; resolved?: ResolvedPath | null }) {
  const content = detail.content.trim();

  return (
    <div>
      {detail.path ? <PathHeader path={detail.path} {...(resolved !== undefined ? { resolved } : {})} /> : null}
      {content ? (
        looksLikeDiff(content) ? (
          <DiffBlock content={detail.content} {...(detail.path ? { filePath: detail.path } : {})} />
        ) : (
          <CodeBlock content={detail.content} {...(detail.path ? { filePath: detail.path } : {})} />
        )
      ) : (
        <EmptyState message="No edited content captured." />
      )}
    </div>
  );
}

function CommandDetail({ detail }: { detail: Extract<ParsedDetail, { kind: "command" }> }) {
  return (
    <div>
      <div className="border-b border-border bg-surface-alt px-2 py-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Command</p>
        <p className="mt-0.5 overflow-x-auto whitespace-pre font-mono text-[11px] text-ink">{detail.command}</p>
      </div>
      <div className="bg-surface">
        {detail.output.trim() ? (
          <pre className="overflow-x-auto px-2 py-2 font-mono text-[11px] leading-6 text-ink-secondary">
            <code>{detail.output}</code>
          </pre>
        ) : (
          <EmptyState message="No command output captured." />
        )}
      </div>
    </div>
  );
}

function SearchDetail({ detail, projectPath }: { detail: Extract<ParsedDetail, { kind: "search" }>; projectPath?: string | null }) {
  return (
    <div>
      <div className="border-b border-border px-2 py-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Query</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-secondary">{detail.query}</p>
      </div>
      {detail.results.length > 0 ? (
        <div className="divide-y divide-border">
          {detail.results.map((result, index) => (
            <SearchResultRow key={`${result}-${String(index)}`} result={result} {...(projectPath !== undefined ? { projectPath } : {})} />
          ))}
        </div>
      ) : (
        <EmptyState message="No search results captured." />
      )}
    </div>
  );
}

function DefaultDetail({ detail }: { detail: Extract<ParsedDetail, { kind: "default" }> }) {
  return (
    <pre className="overflow-x-auto px-2 py-2 font-mono text-[11px] leading-6 text-ink-secondary">
      <code>{detail.content}</code>
    </pre>
  );
}

/** Render tool input args as key-value pairs with syntax-aware formatting. */
function ArgsDetail({ args, projectPath }: { args: Record<string, unknown>; projectPath?: string | null }) {
  // Filter out very long values for summary, show them expandable
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-surface">
      <div className="border-b border-border px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Input</span>
      </div>
      <div className="divide-y divide-border">
        {entries.map(([key, value]) => (
          <ArgEntry key={key} name={key} value={value} {...(projectPath !== undefined ? { projectPath } : {})} />
        ))}
      </div>
    </div>
  );
}

/** Keys whose string values are file paths. */
const PATH_ARG_KEYS = new Set(["file_path", "path"]);
/** Keys whose string values should render as markdown. */
const MARKDOWN_ARG_KEYS = new Set(["prompt"]);

function ArgEntry({ name, value, projectPath }: { name: string; value: unknown; projectPath?: string | null }) {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isLong = str.length > 120 || str.includes("\n");
  // Resolve file path args to relative display
  const isPathArg = typeof value === "string" && PATH_ARG_KEYS.has(name) && value.startsWith("/");
  const resolved = isPathArg ? resolvePath(value, projectPath ?? null) : null;
  const displayStr = resolved ? resolved.display : str;
  const tooltip = resolved ? resolved.full : undefined;

  // Render markdown-capable args (e.g. agent prompt) with MarkdownContent
  const isMarkdownArg = MARKDOWN_ARG_KEYS.has(name) && typeof value === "string";

  if (isLong && !resolved) {
    return (
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 [&::-webkit-details-marker]:hidden">
          <span className="font-mono text-[10px] font-medium text-accent-strong">{name}</span>
          <span className="truncate font-mono text-[11px] text-ink-muted">{str.slice(0, 80)}…</span>
        </summary>
        <div className="border-t border-border">
          {isMarkdownArg ? (
            <div className="px-2 py-1.5">
              <MarkdownContent content={str} />
            </div>
          ) : (
            <pre className="overflow-x-auto px-2 py-1.5 font-mono text-[11px] leading-5 text-ink-secondary">
              <code>{str}</code>
            </pre>
          )}
        </div>
      </details>
    );
  }

  return (
    <div className="flex items-baseline gap-2 px-2 py-1">
      <span className="shrink-0 font-mono text-[10px] font-medium text-accent-strong">{name}</span>
      <span
        className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] ${resolved?.kind === "project" ? "text-status-warning" : resolved?.kind === "external" ? "text-status-error" : "text-ink-secondary"}`}
        style={resolved ? { direction: "rtl", textAlign: "left" } : undefined}
        title={tooltip}
      >
        {resolved ? (
          <bdi>
            {resolved.kind === "project" && "\u26A0 "}
            {resolved.kind === "external" && "\u26A0 "}
            {displayStr}
          </bdi>
        ) : displayStr}
      </span>
    </div>
  );
}

function PathHeader({ path, resolved }: { path: string; resolved?: ResolvedPath | null }) {
  const displayPath = resolved?.display ?? path;
  const fullPath = resolved?.full ?? path;
  const kind = resolved?.kind ?? (path.startsWith("/") ? "external" : "worktree");

  return (
    <div className="border-b border-border px-2 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Path</p>
      <p
        className={`mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] ${
          kind === "project" ? "text-status-warning" : kind === "external" ? "text-status-error" : "text-ink-muted"
        }`}
        style={{ direction: "rtl", textAlign: "left" }}
        title={fullPath}
      >
        <bdi>
          {kind === "project" && "\u26A0 "}
          {kind === "external" && "\u26A0 "}
          {displayPath}
        </bdi>
      </p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-2 py-2 font-mono text-[11px] text-ink-muted">{message}</div>
  );
}

function CodeBlock({ content, filePath }: { content: string; filePath?: string }) {
  const lines = content.replace(/\n$/, "").split("\n");
  const parsedLines = lines.map((line) => {
    const match = line.match(NUMBERED_LINE_RE);
    if (!match) {
      return { number: null, content: line };
    }

    return { number: match[1], content: match[3] };
  });
  const hasLineNumbers = parsedLines.some((line) => line.number !== null);

  if (!hasLineNumbers) {
    if (filePath) {
      const highlighted = highlightCode(content, filePath);
      return (
        <pre className="hljs overflow-x-auto px-2 py-2 font-mono text-[11px] leading-6 text-ink-secondary">
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      );
    }

    return (
      <pre className="overflow-x-auto px-2 py-2 font-mono text-[11px] leading-6 text-ink-secondary">
        <code>{content}</code>
      </pre>
    );
  }

  return (
    <div className="hljs overflow-x-auto font-mono text-[11px] leading-6">
      {parsedLines.map((line, index) => {
        const highlighted = filePath ? highlightCode(line.content || " ", filePath) : null;

        return (
          <div key={`${line.number ?? "plain"}-${String(index)}`} className="grid grid-cols-[3.5rem_minmax(0,1fr)]">
            <span className="border-r border-border px-2 py-0.5 text-right text-ink-muted">
              {line.number ?? ""}
            </span>
            {highlighted ? (
              <span className="whitespace-pre-wrap break-all px-2 py-0.5" dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <span className="whitespace-pre-wrap break-all px-2 py-0.5 text-ink-secondary">
                {line.content || " "}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DiffBlock({ content, filePath }: { content: string; filePath?: string }) {
  const lines = content.replace(/\n$/, "").split("\n");

  return (
    <div className="hljs overflow-x-auto font-mono text-[11px] leading-6">
      {lines.map((line, index) => {
        const marker = getDiffMarker(line);
        const codeContent = marker ? line.slice(1) : line;
        const highlighted = filePath && !isDiffMeta(line) ? highlightCode(codeContent, filePath) : null;

        return (
          <div key={`diff-${String(index)}`} className={`grid grid-cols-[1.25rem_minmax(0,1fr)] ${diffLineBgClassName(line)}`}>
            <span className="border-r border-border px-0.5 py-0.5 text-center text-ink-muted select-none">
              {marker ?? " "}
            </span>
            {highlighted ? (
              <span className={`whitespace-pre-wrap break-all px-2 py-0.5 ${diffLineTextClassName(line)}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <span className={`whitespace-pre-wrap break-all px-2 py-0.5 ${diffLineClassName(line)}`}>
                {line || " "}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SearchResultRow({ result, projectPath }: { result: string; projectPath?: string | null }) {
  const match = result.match(SEARCH_RESULT_RE);

  if (!match) {
    return (
      <div className="px-2 py-1.5 font-mono text-[11px] text-ink-secondary">{result}</div>
    );
  }

  const [, rawPath, line, column, rawSnippet] = match;
  const safeLine = line ?? "";
  const location = column ? `${safeLine}:${column}` : safeLine;
  const snippet = rawSnippet ?? "";
  const resolved = rawPath ? resolvePath(rawPath, projectPath ?? null) : null;

  return (
    <div className="px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <span
          className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] ${
            resolved?.kind === "project" ? "text-status-warning" : resolved?.kind === "external" ? "text-status-error" : "text-ink-muted"
          }`}
          style={{ direction: "rtl", textAlign: "left" }}
          title={resolved?.full ?? rawPath}
        >
          <bdi>
            {resolved?.kind === "project" && "\u26A0 "}
            {resolved?.kind === "external" && "\u26A0 "}
            {resolved?.display ?? rawPath}
          </bdi>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-muted">{location}</span>
      </div>
      {snippet.trim() ? (
        <p className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-ink-secondary">{snippet.trimStart()}</p>
      ) : null}
    </div>
  );
}

function parseDetail(title: string, detail: string, index: number): ParsedDetail {
  const trimmedTitle = title.trim();
  const trimmedDetail = detail.trim();
  const path = extractFilePath(trimmedTitle, trimmedDetail);
  const detailNumber = String(index + 1);
  const fallbackLabel = trimmedTitle || `Detail ${detailNumber}`;

  if (shouldTreatAsEdit(trimmedTitle, trimmedDetail, path)) {
    const content = stripToolMetadata(trimmedDetail, path);
    return {
      kind: "edit",
      label: path ?? summarizeText(fallbackLabel),
      ...(path ? { path } : {}),
      content,
    };
  }

  if (shouldTreatAsSearch(trimmedTitle, trimmedDetail)) {
    const { query, results } = extractSearchParts(trimmedTitle, trimmedDetail);
    return {
      kind: "search",
      label: summarizeText(query || `Search ${detailNumber}`),
      query,
      results,
    };
  }

  if (shouldTreatAsRead(trimmedTitle, trimmedDetail, path)) {
    const content = stripToolMetadata(trimmedDetail, path);
    return {
      kind: "read",
      label: path ?? summarizeText(fallbackLabel),
      ...(path ? { path } : {}),
      content,
    };
  }

  if (shouldTreatAsCommand(trimmedTitle, trimmedDetail)) {
    const { command, output } = extractCommandParts(trimmedTitle, trimmedDetail);
    return {
      kind: "command",
      label: summarizeText(command || `Command ${detailNumber}`),
      command: command || trimmedTitle || trimmedDetail,
      output,
    };
  }

  return {
    kind: "default",
    label: summarizeText(firstNonEmptyLine(trimmedDetail) ?? fallbackLabel),
    content: detail,
  };
}

function shouldTreatAsEdit(title: string, detail: string, path?: string): boolean {
  if (EDIT_TITLE_RE.test(title)) {
    return true;
  }

  if (looksLikeDiff(detail)) {
    return true;
  }

  return Boolean(path && /(?:^|\n)(?:updated|replacement|patch)\b/i.test(detail));
}

function shouldTreatAsSearch(title: string, detail: string): boolean {
  if (SEARCH_TITLE_RE.test(title)) {
    return true;
  }

  if (/^(?:pattern|query|search|glob)\s*:/im.test(detail)) {
    return true;
  }

  const lines = detail.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 1 && lines.filter((line) => SEARCH_RESULT_RE.test(line)).length >= 2;
}

function shouldTreatAsRead(title: string, detail: string, path?: string): boolean {
  if (READ_TITLE_RE.test(title)) {
    return true;
  }

  if (/^(?:file|path)\s*:/im.test(detail) && !looksLikeDiff(detail)) {
    return true;
  }

  return Boolean(path && (detail === path || NUMBERED_LINE_RE.test(detail) || detail.includes("\n")));
}

function shouldTreatAsCommand(title: string, detail: string): boolean {
  if (COMMAND_TITLE_RE.test(title)) {
    return true;
  }

  if (/^(?:command|cmd|bash|shell)\s*:/im.test(detail)) {
    return true;
  }

  return looksLikeShellCommand(title);
}

function extractFilePath(title: string, detail: string): string | undefined {
  const candidates = [
    extractPathCandidate(title),
    extractPathCandidate(firstNonEmptyLine(detail) ?? ""),
    extractPathCandidate(detail),
  ];

  return candidates.find((candidate) => candidate !== undefined);
}

function extractPathCandidate(value: string): string | undefined {
  const trimmed = stripQuotes(value.trim());
  if (!trimmed) {
    return undefined;
  }

  if (isLikelyFilePath(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/^(?:file|path|read|edit|write|cat)\s*[: ]\s*(.+)$/i);
  if (!match) {
    return undefined;
  }

  const rawCandidate = match[1];
  if (!rawCandidate) {
    return undefined;
  }

  const candidate = stripQuotes(rawCandidate.trim());
  return isLikelyFilePath(candidate) ? candidate : undefined;
}

function extractSearchParts(title: string, detail: string): { query: string; results: string[] } {
  const lines = detail.split("\n");
  let query =
    extractLabeledLine(lines, /^(?:pattern|query|search|glob)\s*:\s*(.+)$/i) ??
    extractSearchTitle(title) ??
    "";
  let results = lines.filter((line) => line.trim().length > 0);

  if (query) {
    results = results.filter((line) => {
      const normalized = line.trim();
      return normalized.toLowerCase() !== query.toLowerCase() && !/^(?:pattern|query|search|glob)\s*:/i.test(normalized);
    });
  } else if (results.length > 0) {
    const [firstResult, ...remainingResults] = results;
    if (!firstResult) {
      return { query: title, results: [] };
    }

    query = firstResult;
    results = remainingResults;
  }

  return { query: query || title, results };
}

function extractSearchTitle(title: string): string | undefined {
  const match = title.match(/\b(?:grep|glob|search|rg|ripgrep|find)\b[: ]\s*(.+)$/i);
  return match?.[1]?.trim();
}

function extractCommandParts(title: string, detail: string): { command: string; output: string } {
  const lines = detail.split("\n");
  const command =
    extractLabeledLine(lines, /^(?:command|cmd|bash|shell)\s*:\s*(.+)$/i) ??
    extractCommandTitle(title) ??
    (looksLikeShellCommand(detail) ? firstNonEmptyLine(detail) ?? detail : "");

  const outputMatch = detail.match(/(?:^|\n)(?:output|stdout|stderr|result)\s*:\s*\n?([\s\S]*)$/i);
  if (outputMatch) {
    return { command, output: outputMatch[1]?.trim() ?? "" };
  }

  if (!command) {
    return { command: title || detail, output: "" };
  }

  if (detail.trim() === command.trim()) {
    return { command, output: "" };
  }

  const withoutLabeledCommand = detail.replace(/^(?:command|cmd|bash|shell)\s*:\s*.+$/im, "").trim();
  if (withoutLabeledCommand) {
    return { command, output: withoutLabeledCommand };
  }

  return { command, output: "" };
}

function extractCommandTitle(title: string): string | undefined {
  const match = title.match(/^(?:bash|command|shell)\s*:\s*(.+)$/i);
  if (match?.[1]) {
    return match[1].trim();
  }

  return looksLikeShellCommand(title) ? title : undefined;
}

function stripToolMetadata(detail: string, path?: string): string {
  const lines = detail.split("\n");
  const remaining = [...lines];

  while (remaining.length > 0) {
    const first = remaining[0]?.trim() ?? "";

    if (!first) {
      remaining.shift();
      continue;
    }

    if (path && stripQuotes(first) === path) {
      remaining.shift();
      continue;
    }

    if (/^(?:file|path)\s*:/i.test(first)) {
      remaining.shift();
      continue;
    }

    break;
  }

  return remaining.join("\n").trim();
}

function looksLikeDiff(content: string): boolean {
  return content
    .split("\n")
    .some((line) =>
      /^diff --git /.test(line) ||
      /^@@/.test(line) ||
      /^--- /.test(line) ||
      /^\+\+\+ /.test(line) ||
      /^[+-](?![+-])/.test(line),
    );
}

function getDiffMarker(line: string): string | null {
  if (/^[+](?![+])/.test(line)) return "+";
  if (/^-(?!-)/.test(line)) return "\u2212";
  return null;
}

function isDiffMeta(line: string): boolean {
  return /^diff --git /.test(line) || /^@@/.test(line) || /^\+\+\+ /.test(line) || /^--- /.test(line);
}

function diffLineBgClassName(line: string): string {
  if (isDiffMeta(line)) return "bg-accent/10";
  if (/^[+](?![+])/.test(line)) return "bg-emerald-600/5";
  if (/^-(?!-)/.test(line)) return "bg-status-error/5";
  return "";
}

function diffLineTextClassName(line: string): string {
  if (/^[+](?![+])/.test(line)) return "text-emerald-800";
  if (/^-(?!-)/.test(line)) return "text-status-error";
  return "";
}

function diffLineClassName(line: string): string {
  if (isDiffMeta(line)) return "bg-accent/10 text-accent-strong";
  if (/^[+](?![+])/.test(line)) return "bg-emerald-600/5 text-emerald-800";
  if (/^-(?!-)/.test(line)) return "bg-status-error/5 text-status-error";
  return "text-ink-secondary";
}

function extractLabeledLine(lines: string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split("\n").find((line) => line.trim().length > 0)?.trim();
}

function looksLikeShellCommand(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && COMMON_COMMAND_RE.test(trimmed);
}

function isLikelyFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240) {
    return false;
  }

  if (trimmed.includes("\n") || looksLikeShellCommand(trimmed)) {
    return false;
  }

  return (
    /^\.{0,2}\//.test(trimmed) ||
    /^~\//.test(trimmed) ||
    /^[A-Za-z]:\\/.test(trimmed) ||
    /^[\w@.-]+\/[\w@./-]+$/.test(trimmed) ||
    /\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?$/.test(trimmed)
  );
}

function stripQuotes(value: string): string {
  return value.replace(/^["'`]+|["'`]+$/g, "");
}

function summarizeText(value: string, maxLength = 72): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

/** Synthesize a unified-diff-like ParsedDetail from Edit tool args (old_string → new_string). */
function synthesizeEditDiff(args: Record<string, unknown> | null): ParsedDetail | null {
  if (!args) return null;
  const oldStr = typeof args["old_string"] === "string" ? args["old_string"] : null;
  const newStr = typeof args["new_string"] === "string" ? args["new_string"] : null;
  if (oldStr == null || newStr == null) return null;

  const path = typeof args["file_path"] === "string" ? args["file_path"] : undefined;
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const diffLines: string[] = [];
  for (const line of oldLines) diffLines.push(`-${line}`);
  for (const line of newLines) diffLines.push(`+${line}`);

  return {
    kind: "edit",
    label: path ?? "Edit diff",
    ...(path ? { path } : {}),
    content: diffLines.join("\n"),
  };
}
