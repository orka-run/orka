export type LogEvent =
  | { kind: "message"; text: string }
  | { kind: "tool_call"; tool: string; input: string }
  | { kind: "tool_result"; tool: string; output: string; exitCode?: number }
  | { kind: "error"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "system"; text: string }
  | { kind: "info"; text: string };

type JsonRecord = Record<string, unknown>;

const EXIT_CODE_LINE = /^\[orka\] exit_code=(\d+)$/;
const COLORS_ENABLED = process.env["NO_COLOR"] == null;

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

  switch (parsed["type"]) {
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
        output: truncateText(extractText(parsed["content"] ?? parsed["result"] ?? parsed["output"] ?? parsed), 500),
      };
    case "result":
      return { kind: "message", text: `--- RESULT ---\n${parsed["result"] ?? ""}` };
    case "system":
      return parseClaudeSystem(parsed);
    case "rate_limit_event":
      return parseClaudeRateLimit(parsed);
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
    case "warning":
      return yellow(`WARN: ${event.text}`);
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
  const item = parsed["item"];
  if (!isRecord(item)) return null;

  if (item["type"] === "agent_message") {
    return { kind: "message", text: typeof item["text"] === "string" ? item["text"] : "" };
  }

  if (item["type"] === "command_execution") {
    const exitCode = typeof item["exit_code"] === "number" ? item["exit_code"] : undefined;
    return {
      kind: "tool_result",
      tool: typeof item["command"] === "string" ? item["command"] : "",
      output: unescapeString(typeof item["aggregated_output"] === "string" ? item["aggregated_output"] : ""),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  return null;
}

function parseCodexStarted(_parsed: JsonRecord): LogEvent | null {
  return null;
}

function parseCodexTurnCompletion(parsed: JsonRecord): LogEvent {
  const usage = isRecord(parsed["usage"]) ? parsed["usage"] : {};
  const inputTokens = usage["input_tokens"] ?? usage["inputTokens"] ?? 0;
  const outputTokens = usage["output_tokens"] ?? usage["outputTokens"] ?? 0;
  return {
    kind: "info",
    text: `turn complete (${inputTokens} input, ${outputTokens} output tokens)`,
  };
}

function parseClaudeAssistant(parsed: JsonRecord): LogEvent | null {
  const message = isRecord(parsed["message"]) ? parsed["message"] : undefined;
  const content: unknown[] = Array.isArray(message?.["content"]) ? message["content"] : [];
  const first = content.find((item) => item && typeof item === "object");
  if (!first) return null;

  if (isRecord(first) && first["type"] === "text") {
    const text = content
      .filter((item): item is JsonRecord => isRecord(item) && item["type"] === "text" && typeof item["text"] === "string")
      .map((item) => item["text"] as string)
      .join("\n");
    return { kind: "message", text };
  }

  if (isRecord(first) && first["type"] === "tool_use") {
    const toolName = typeof first["name"] === "string" ? first["name"] : "";
    return {
      kind: "tool_call",
      tool: toolName,
      input: formatClaudeToolInput(toolName, first["input"]),
    };
  }

  return null;
}

function parseClaudeSystem(parsed: JsonRecord): LogEvent | null {
  if (parsed["subtype"] === "init") {
    const session = isRecord(parsed["session"]) ? parsed["session"] : undefined;
    const model = parsed["model"] ?? session?.["model"] ?? "unknown";
    const mode = parsed["permissionMode"] ?? parsed["permission_mode"] ?? parsed["mode"] ?? "unknown";
    return {
      kind: "system",
      text: `session started (model: ${model}, mode: ${mode})`,
    };
  }

  if (parsed["subtype"] === "api_retry") {
    const retry = normalizeApiRetryInfo(parsed);
    if (!retry) {
      return null;
    }

    return {
      kind: "info",
      text: isRateLimitRetryError(retry.error)
        ? `Rate limited - retrying in ${formatRetryDelay(retry.delayMs)} (attempt ${String(retry.attempt)}/${String(retry.maxAttempts)})`
        : `API retry (attempt ${String(retry.attempt)}/${String(retry.maxAttempts)}) - ${formatRetryError(retry.error)}, waiting ${formatRetryDelay(retry.delayMs)}`,
    };
  }

  return null;
}

function parseClaudeRateLimit(parsed: JsonRecord): LogEvent | null {
  const info = normalizeRateLimitInfo(parsed["rate_limit_info"]);
  if (!info || info.status === "allowed") {
    return null;
  }

  if (isUsageBudgetType(info.rateLimitType)) {
    const budgetWindow = formatBudgetWindow(info.rateLimitType);
    if (info.status === "rejected") {
      return {
        kind: "error",
        text: `Usage limit reached - ${budgetWindow ? `${budgetWindow} budget resets at ${formatResetTime(info.resetsAt)}` : `resets at ${formatResetTime(info.resetsAt)}`}`,
      };
    }

    return {
      kind: "warning",
      text: `Usage: ${formatUtilization(info.utilization)}${budgetWindow ? ` of ${budgetWindow} budget` : ""} (resets in ${formatResetDistance(info.resetsAt)})`,
    };
  }

  if (info.status === "rejected") {
    return {
      kind: "error",
      text: `Rate limited - retry after ${formatResetTime(info.resetsAt)}`,
    };
  }

  return { kind: "warning", text: "Rate limited - retrying" };
}

function normalizeApiRetryInfo(parsed: JsonRecord): { attempt: number; maxAttempts: number; error: string; delayMs: number } | null {
  const info = isRecord(parsed["api_retry_info"]) ? parsed["api_retry_info"] : parsed;
  const attempt = typeof info["attempt"] === "number" ? info["attempt"] : null;
  const maxAttempts =
    typeof info["max_attempts"] === "number"
      ? info["max_attempts"]
      : typeof info["max_retries"] === "number"
        ? info["max_retries"]
        : null;
  const error = typeof info["error"] === "string" ? info["error"] : null;
  const delayMs =
    typeof info["delay_ms"] === "number"
      ? info["delay_ms"]
      : typeof info["retry_delay_ms"] === "number"
        ? info["retry_delay_ms"]
        : null;

  if (attempt == null || maxAttempts == null || error == null || delayMs == null) {
    return null;
  }

  return { attempt, maxAttempts, error, delayMs };
}

function normalizeRateLimitInfo(value: unknown): { status: string; resetsAt: number; rateLimitType?: string; utilization?: number } | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = typeof value["status"] === "string" ? value["status"] : null;
  const resetsAt = typeof value["resetsAt"] === "number" ? value["resetsAt"] : null;
  const rateLimitType = typeof value["rateLimitType"] === "string" ? value["rateLimitType"] : undefined;
  const utilization = typeof value["utilization"] === "number" ? value["utilization"] : undefined;
  if (status == null || resetsAt == null) {
    return null;
  }

  return {
    status,
    resetsAt,
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
  };
}

function isUsageBudgetType(rateLimitType?: string): boolean {
  return rateLimitType === "five_hour" || rateLimitType === "seven_day";
}

function formatBudgetWindow(rateLimitType?: string): string | null {
  switch (rateLimitType) {
    case "five_hour":
      return "5h";
    case "seven_day":
      return "7d";
    default:
      return null;
  }
}

function isRateLimitRetryError(error: string): boolean {
  return /\b429\b|rate[_ -]?limit/i.test(error);
}

function formatRetryError(error: string): string {
  return error.replace(/_error$/i, "").replace(/_/g, " ");
}

function formatRetryDelay(delayMs: number): string {
  const seconds = delayMs / 1000;
  return Number.isInteger(seconds) ? `${String(seconds)}s` : `${seconds.toFixed(1)}s`;
}

function formatUtilization(utilization?: number): string {
  if (utilization === undefined) {
    return "unknown";
  }

  return `${Math.round(utilization * 100)}%`;
}

function formatResetDistance(epochSeconds: number): string {
  const deltaSeconds = Math.max(0, Math.round(epochSeconds - Date.now() / 1000));
  const totalMinutes = Math.round(deltaSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatResetTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatClaudeToolInput(tool: string, input: unknown): string {
  if (tool === "Bash" && isRecord(input)) {
    return typeof input["command"] === "string" ? input["command"] : "";
  }

  if ((tool === "Write" || tool === "Edit" || tool === "Read") && isRecord(input)) {
    if (typeof input["file_path"] === "string") return input["file_path"];
    if (typeof input["filePath"] === "string") return input["filePath"];
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
    if (typeof value["text"] === "string") return value["text"];
    if (typeof value["content"] === "string") return value["content"];
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

function yellow(text: string): string {
  return style(text, 33);
}

function dimItalic(text: string): string {
  return style(text, 2, 3);
}
