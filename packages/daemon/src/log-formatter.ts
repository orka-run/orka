export type LogEvent =
  | { kind: "message"; text: string }
  | { kind: "tool_call"; tool: string; input: string }
  | { kind: "tool_result"; tool: string; output: string; exitCode?: number }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string }
  | { kind: "info"; text: string };

type JsonRecord = Record<string, any>;

const EXIT_CODE_LINE = /^\[orka\] exit_code=(\d+)$/;
const COLORS_ENABLED = process.env.NO_COLOR == null;

/** Parse a single line from a log file and return a LogEvent, or null if the line should be skipped. */
export function parseLine(line: string): LogEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const exitCodeMatch = trimmed.match(EXIT_CODE_LINE);
  if (exitCodeMatch) {
    return { kind: "info", text: `exit code: ${exitCodeMatch[1]}` };
  }

  if (!trimmed.startsWith("{")) {
    return { kind: "message", text: line };
  }

  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  switch (parsed.type) {
    case "item.completed":
      return parseCodexCompleted(parsed);
    case "item.started":
      return parseCodexStarted(parsed);
    case "turn.started":
      return { kind: "system", text: "--- turn ---" };
    case "turn.completed":
      return parseCodexTurnCompletion(parsed);
    case "assistant":
      return parseClaudeAssistant(parsed);
    case "tool":
    case "tool_result":
      return {
        kind: "tool_result",
        tool: "",
        output: truncateText(extractText(parsed.content ?? parsed.result ?? parsed.output ?? parsed), 500),
      };
    case "result":
      return { kind: "message", text: `--- RESULT ---\n${parsed.result ?? ""}` };
    case "system":
      return parseClaudeSystem(parsed);
    default:
      return null;
  }
}

/** Format a LogEvent for terminal display (with ANSI colors unless NO_COLOR is set). */
export function formatEvent(event: LogEvent): string {
  switch (event.kind) {
    case "message":
      return event.text;
    case "tool_call": {
      const input = previewText(event.input, 120);
      const prefix = dim("▶ ");
      const tool = cyan(event.tool);
      return input ? `${prefix}${tool}${dim(` ${input}`)}` : `${prefix}${tool}`;
    }
    case "tool_result":
      if (event.exitCode && event.exitCode !== 0) {
        return `${red(`✗ ${event.tool || "command"}`)}\n`;
      }
      return `${formatToolResultOutput(event.output)}\n`;
    case "error":
      return red(`ERROR: ${event.text}`);
    case "system":
      return dimItalic(event.text);
    case "info":
      return dim(event.text);
  }
}

/** Format an entire log file content into human-readable output. */
export function formatLog(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => parseLine(line))
    .filter((event): event is LogEvent => event !== null)
    .map((event) => formatEvent(event))
    .join("\n");
}

function parseCodexCompleted(parsed: JsonRecord): LogEvent | null {
  const item = parsed.item;
  if (!item || typeof item !== "object") return null;

  if (item.type === "agent_message") {
    return { kind: "message", text: item.text ?? "" };
  }

  if (item.type === "command_execution") {
    return {
      kind: "tool_result",
      tool: item.command ?? "",
      output: unescapeString(item.aggregated_output ?? ""),
      exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined,
    };
  }

  return null;
}

function parseCodexStarted(_parsed: JsonRecord): LogEvent | null {
  return null;
}

function parseCodexTurnCompletion(parsed: JsonRecord): LogEvent {
  const usage = parsed.usage ?? {};
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
  return {
    kind: "info",
    text: `turn complete (${inputTokens} input, ${outputTokens} output tokens)`,
  };
}

function parseClaudeAssistant(parsed: JsonRecord): LogEvent | null {
  const content = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
  const first = content.find((item) => item && typeof item === "object");
  if (!first) return null;

  if (first.type === "text") {
    const text = content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    return { kind: "message", text };
  }

  if (first.type === "tool_use") {
    return {
      kind: "tool_call",
      tool: first.name ?? "",
      input: formatClaudeToolInput(first.name ?? "", first.input),
    };
  }

  return null;
}

function parseClaudeSystem(parsed: JsonRecord): LogEvent | null {
  if (parsed.subtype !== "init") return null;

  const model = parsed.model ?? parsed.session?.model ?? "unknown";
  const mode = parsed.permissionMode ?? parsed.permission_mode ?? parsed.mode ?? "unknown";
  return {
    kind: "system",
    text: `session started (model: ${model}, mode: ${mode})`,
  };
}

function formatClaudeToolInput(tool: string, input: unknown): string {
  if (tool === "Bash" && isRecord(input)) {
    return typeof input.command === "string" ? input.command : "";
  }

  if ((tool === "Write" || tool === "Edit" || tool === "Read") && isRecord(input)) {
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.filePath === "string") return input.filePath;
    return "";
  }

  if (typeof input === "string") return input;
  if (input == null) return "";
  return JSON.stringify(input, null, 2);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => extractText(entry)).filter(Boolean).join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    return JSON.stringify(value, null, 2);
  }
  return "";
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object";
}

function previewText(text: string, maxLength: number): string {
  return truncateText(
    text
      .replace(/\r/g, "")
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" "),
    maxLength,
  );
}

function formatToolResultOutput(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n");
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const preview = lines.slice(0, 3).map((line) => dim(truncateText(line, 120)));
  const remaining = lines.length - preview.length;
  if (remaining > 0) {
    preview.push(dim(`... (${remaining} more lines)`));
  }
  return preview.join("\n");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

function unescapeString(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function style(text: string, ...codes: number[]): string {
  if (!COLORS_ENABLED || !text) return text;
  return `\u001B[${codes.join(";")}m${text}\u001B[0m`;
}

function dim(text: string): string {
  return style(text, 2);
}

function cyan(text: string): string {
  return style(text, 36);
}

function red(text: string): string {
  return style(text, 31);
}

function dimItalic(text: string): string {
  return style(text, 2, 3);
}
