import { memo, type ReactElement } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode2,
  Globe,
  LoaderCircle,
  Search,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { ToolCallDetails as ToolCallDetailsBody } from "../ToolCallDetails";
import { formatRelativeTime } from "../../lib/sessionUi";
import type { ToolCallGroup as ToolCallGroupEntry, ToolEntry, ToolIcon } from "./eventsToEntries";

function toolIconEl(icon: ToolIcon, size: string): ReactElement {
  switch (icon) {
    case "command":
      return <TerminalSquare className={size} />;
    case "file":
      return <FileCode2 className={size} />;
    case "read":
      return <Eye className={size} />;
    case "search":
      return <Search className={size} />;
    case "web":
      return <Globe className={size} />;
    case "agent":
      return <Bot className={size} />;
  }
}

function buildToolGroupSummary(tools: ToolEntry[]): string {
  const counts: Record<string, number> = {};
  let inProgressCount = 0;

  for (const tool of tools) {
    counts[tool.icon] = (counts[tool.icon] ?? 0) + 1;
    if (tool.inProgress) {
      inProgressCount += 1;
    }
  }

  const labels: Record<string, [string, string]> = {
    file: ["edit", "edits"],
    read: ["read", "reads"],
    command: ["command", "commands"],
    search: ["search", "searches"],
    web: ["fetch", "fetches"],
    agent: ["agent", "agents"],
  };

  const parts: string[] = [];
  for (const [icon, count] of Object.entries(counts)) {
    const [singular, plural] = labels[icon] ?? ["call", "calls"];
    parts.push(`${String(count)} ${count === 1 ? singular : plural}`);
  }

  const text = parts.length > 0 ? parts.join(", ") : `${String(tools.length)} tool calls`;
  return inProgressCount > 0 ? `${text} (${String(inProgressCount)} in progress)` : text;
}

function ToolCallDetails({
  tools,
  projectPath,
}: {
  tools: ToolEntry[];
  projectPath?: string;
}) {
  return (
    <div className="border-t border-border">
      {tools.map((tool) => (
        <details key={tool.id} className="overflow-hidden border-b border-border/50 last:border-b-0">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
              {tool.inProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : toolIconEl(tool.icon, "h-3 w-3")}
            </div>
            <span className="min-w-0 truncate text-[11px] font-medium text-ink-secondary">{tool.title}</span>
            {tool.summary !== tool.title ? (
              <span className="ml-auto max-w-[40%] shrink-0 truncate text-[10px] text-ink-muted">{tool.summary}</span>
            ) : null}
          </summary>
          {tool.details.length > 0 || tool.args ? (
            <div className="border-t border-border/30 px-2 py-1">
              <ToolCallDetailsBody
                title={tool.title}
                details={tool.details}
                args={tool.args}
                {...(projectPath ? { projectPath } : {})}
              />
            </div>
          ) : null}
        </details>
      ))}
    </div>
  );
}

export const ToolCallGroup = memo(function ToolCallGroup({
  entry,
  isExpanded,
  isCollapsed,
  onToggleExpand,
  projectPath,
}: {
  entry: ToolCallGroupEntry;
  isExpanded?: boolean;
  /** User explicitly collapsed this group — overrides auto-expand from inProgress. */
  isCollapsed?: boolean;
  onToggleExpand?: (groupId: string, isOpen: boolean) => void;
  projectPath?: string;
}) {
  const hasInProgress = entry.tools.some((tool) => tool.inProgress);

  if (entry.tools.length === 1) {
    const tool = entry.tools[0];
    if (!tool) {
      return null;
    }

    const isOpen = isCollapsed ? false : (isExpanded ?? false);

    return (
      <details
        open={isOpen}
        onToggle={(event) => {
          const nextState = event.currentTarget.open;
          if (nextState !== isOpen) {
            onToggleExpand?.(entry.id, nextState);
          }
        }}
        className="overflow-hidden rounded-sm border border-border bg-surface-alt"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1">
          <ChevronRight className={`h-3 w-3 shrink-0 text-ink-muted transition-transform ${isOpen ? "rotate-90" : ""}`} />
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
            {tool.inProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : toolIconEl(tool.icon, "h-3 w-3")}
          </div>
          <span className="min-w-0 truncate text-[11px] text-ink-secondary">{tool.title}</span>
          {tool.summary !== tool.title ? (
            <span className="ml-auto max-w-[40%] shrink-0 truncate text-[10px] text-ink-muted">{tool.summary}</span>
          ) : null}
        </summary>
        {tool.details.length > 0 || tool.args ? (
          <div className="border-t border-border/30 px-2 py-1">
            <ToolCallDetailsBody
              title={tool.title}
              details={tool.details}
              args={tool.args}
              {...(projectPath ? { projectPath } : {})}
            />
          </div>
        ) : null}
        {tool.subTools && tool.subTools.length > 0 ? (
          <div className="border-t border-border/30">
            <ToolCallDetails tools={tool.subTools} {...(projectPath ? { projectPath } : {})} />
          </div>
        ) : null}
      </details>
    );
  }

  if (entry.tools.length >= 3) {
    // Auto-expand when tools are in progress, UNLESS user explicitly collapsed
    const isOpen = isCollapsed ? false : (hasInProgress || (isExpanded ?? false));
    const summary = buildToolGroupSummary(entry.tools);

    return (
      <details
        open={isOpen}
        onToggle={(event) => {
          const nextState = event.currentTarget.open;
          if (nextState !== isOpen) {
            onToggleExpand?.(entry.id, nextState);
          }
        }}
        className="overflow-hidden rounded-sm border border-border bg-surface-alt"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1">
          <div className="flex items-center gap-1.5">
            {isOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-ink-muted transition-transform" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-ink-muted transition-transform" />
            )}
            <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
              {hasInProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
            </div>
            <p className="text-[11px] text-ink-muted">{summary}</p>
          </div>
          <div className="shrink-0 text-[10px] text-ink-muted">{formatRelativeTime(entry.timestamp)}</div>
        </summary>
        <ToolCallDetails tools={entry.tools} {...(projectPath ? { projectPath } : {})} />
      </details>
    );
  }

  const isOpen = isCollapsed ? false : true;
  const label = hasInProgress ? `Using ${String(entry.tools.length)} tools…` : `Used ${String(entry.tools.length)} tools`;
  return (
    <details
      open={isOpen}
      onToggle={(event) => {
        const nextState = event.currentTarget.open;
        if (nextState !== isOpen) {
          onToggleExpand?.(entry.id, nextState);
        }
      }}
      className="overflow-hidden rounded-sm border border-border bg-surface-alt"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1">
        <div className="flex items-center gap-1.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
            {hasInProgress ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
          </div>
          <p className="text-[11px] text-ink-muted">{label}</p>
        </div>
        <div className="shrink-0 text-[10px] text-ink-muted">{formatRelativeTime(entry.timestamp)}</div>
      </summary>
      <ToolCallDetails tools={entry.tools} {...(projectPath ? { projectPath } : {})} />
    </details>
  );
});
