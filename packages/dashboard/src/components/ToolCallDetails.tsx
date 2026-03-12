interface ToolCallDetailsProps {
  title: string;
  details: string[];
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

export function ToolCallDetails({ title, details }: ToolCallDetailsProps) {
  if (details.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-xs text-zinc-500">
        No tool details recorded.
      </div>
    );
  }

  const parsedDetails = details.map((detail, index) => parseDetail(title, detail, index));

  return (
    <div className="space-y-2">
      {parsedDetails.map((detail, index) => (
        <details
          key={`${detail.kind}-${detail.label}-${String(index)}`}
          open={index === 0}
          className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/80"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
            <span className="truncate font-mono text-xs text-zinc-300">{detail.label}</span>
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              {detail.kind}
            </span>
          </summary>
          <div className="border-t border-zinc-800">
            {detail.kind === "read" ? <ReadDetail detail={detail} /> : null}
            {detail.kind === "edit" ? <EditDetail detail={detail} /> : null}
            {detail.kind === "command" ? <CommandDetail detail={detail} /> : null}
            {detail.kind === "search" ? <SearchDetail detail={detail} /> : null}
            {detail.kind === "default" ? <DefaultDetail detail={detail} /> : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function ReadDetail({ detail }: { detail: Extract<ParsedDetail, { kind: "read" }> }) {
  return (
    <div>
      {detail.path ? <PathHeader path={detail.path} /> : null}
      {detail.content.trim() ? (
        <CodeBlock content={detail.content} />
      ) : (
        <EmptyState message="No file content captured." />
      )}
    </div>
  );
}

function EditDetail({ detail }: { detail: Extract<ParsedDetail, { kind: "edit" }> }) {
  const content = detail.content.trim();
  const isDiff = looksLikeDiff(content);

  return (
    <div>
      {detail.path ? <PathHeader path={detail.path} /> : null}
      {content ? (
        isDiff ? <DiffBlock content={detail.content} /> : <CodeBlock content={detail.content} />
      ) : (
        <EmptyState message="No edited content captured." />
      )}
    </div>
  );
}

function CommandDetail({ detail }: { detail: Extract<ParsedDetail, { kind: "command" }> }) {
  return (
    <div>
      <div className="border-b border-zinc-800 bg-zinc-800/70 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Command</p>
        <p className="mt-1 overflow-x-auto whitespace-pre font-mono text-xs text-zinc-100">{detail.command}</p>
      </div>
      <div className="bg-zinc-950">
        {detail.output.trim() ? (
          <pre className="overflow-x-auto px-3 py-3 font-mono text-xs leading-6 text-zinc-300">
            <code>{detail.output}</code>
          </pre>
        ) : (
          <EmptyState message="No command output captured." />
        )}
      </div>
    </div>
  );
}

function SearchDetail({ detail }: { detail: Extract<ParsedDetail, { kind: "search" }> }) {
  return (
    <div>
      <div className="border-b border-zinc-800 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Query</p>
        <p className="mt-1 font-mono text-xs text-zinc-300">{detail.query}</p>
      </div>
      {detail.results.length > 0 ? (
        <div className="divide-y divide-zinc-900">
          {detail.results.map((result, index) => (
            <SearchResultRow key={`${result}-${String(index)}`} result={result} />
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
    <pre className="overflow-x-auto px-3 py-3 font-mono text-xs leading-6 text-zinc-300">
      <code>{detail.content}</code>
    </pre>
  );
}

function PathHeader({ path }: { path: string }) {
  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Path</p>
      <p className="mt-1 break-all font-mono text-xs text-zinc-400">{path}</p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-3 py-3 font-mono text-xs text-zinc-500">{message}</div>
  );
}

function CodeBlock({ content }: { content: string }) {
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
    return (
      <pre className="overflow-x-auto px-3 py-3 font-mono text-xs leading-6 text-zinc-200">
        <code>{content}</code>
      </pre>
    );
  }

  return (
    <div className="overflow-x-auto font-mono text-xs leading-6">
      {parsedLines.map((line, index) => (
        <div key={`${line.number ?? "plain"}-${String(index)}`} className="grid grid-cols-[3.5rem_minmax(0,1fr)]">
          <span className="border-r border-zinc-900/80 px-2 py-1 text-right text-zinc-500">
            {line.number ?? ""}
          </span>
          <span className="whitespace-pre-wrap break-all px-3 py-1 text-zinc-200">
            {line.content || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function DiffBlock({ content }: { content: string }) {
  const lines = content.replace(/\n$/, "").split("\n");

  return (
    <div className="overflow-x-auto font-mono text-xs leading-6">
      {lines.map((line, index) => (
        <div key={`${line}-${String(index)}`} className="grid grid-cols-[3rem_minmax(0,1fr)]">
          <span className="border-r border-zinc-900/80 px-2 py-1 text-right text-zinc-600">{index + 1}</span>
          <span className={`whitespace-pre-wrap break-all px-3 py-1 ${diffLineClassName(line)}`}>
            {line || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function SearchResultRow({ result }: { result: string }) {
  const match = result.match(SEARCH_RESULT_RE);

  if (!match) {
    return (
      <div className="px-3 py-2 font-mono text-xs text-zinc-300">{result}</div>
    );
  }

  const [, path, line, column, rawSnippet] = match;
  const safeLine = line ?? "";
  const location = column ? `${safeLine}:${column}` : safeLine;
  const snippet = rawSnippet ?? "";

  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="break-all font-mono text-xs text-zinc-400">{path}</span>
        <span className="shrink-0 font-mono text-[11px] text-zinc-500">{location}</span>
      </div>
      {snippet.trim() ? (
        <p className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-zinc-200">{snippet.trimStart()}</p>
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

function diffLineClassName(line: string): string {
  if (/^\+\+\+ /.test(line) || /^--- /.test(line) || /^@@/.test(line)) {
    return "bg-sky-400/10 text-sky-200";
  }

  if (/^[+](?![+])/.test(line)) {
    return "bg-emerald-400/10 text-emerald-200";
  }

  if (/^-(?!-)/.test(line)) {
    return "bg-red-400/10 text-red-200";
  }

  return "text-zinc-200";
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
