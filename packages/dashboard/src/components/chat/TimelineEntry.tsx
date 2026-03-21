import { memo } from "react";
import { Bot, LoaderCircle } from "lucide-react";
import { ApprovalCard } from "../ApprovalCard";
import { BackgroundTaskCard } from "./BackgroundTaskCard";
import { AssistantMessage, SystemMessage, UserMessage } from "./MessageEntry";
import { ApiRetryEntry, ErrorEntry, RateLimitEntry } from "./StatusEntries";
import { ToolCallGroup } from "./ToolCallEntry";
import type { ChatEntry, ThinkingState } from "./eventsToEntries";

export const ChatTimelineEntry = memo(function ChatTimelineEntry({
  entry,
  isExpanded,
  onToggleExpand,
  onApprovalResolve,
  projectPath,
}: {
  entry: ChatEntry;
  isExpanded?: boolean;
  onToggleExpand?: (groupId: string, isOpen: boolean) => void;
  onApprovalResolve?: (requestId: string, decision: "approve" | "deny") => Promise<void>;
  projectPath?: string;
}) {
  if (entry.type === "approval" && onApprovalResolve) {
    return <ApprovalCard entry={entry} onResolve={onApprovalResolve} />;
  }
  if (entry.type === "assistant") {
    return <AssistantMessage entry={entry} />;
  }
  if (entry.type === "user") {
    return <UserMessage entry={entry} />;
  }
  if (entry.type === "tool-group") {
    return (
      <ToolCallGroup
        entry={entry}
        {...(isExpanded !== undefined ? { isExpanded } : {})}
        {...(onToggleExpand ? { onToggleExpand } : {})}
        {...(projectPath ? { projectPath } : {})}
      />
    );
  }
  if (entry.type === "background-task") {
    return <BackgroundTaskCard entry={entry} />;
  }
  if (entry.type === "rate-limit") {
    return <RateLimitEntry entry={entry} />;
  }
  if (entry.type === "api-retry") {
    return <ApiRetryEntry entry={entry} />;
  }
  if (entry.type === "error") {
    return <ErrorEntry entry={entry} />;
  }
  return entry.type === "approval" ? null : <SystemMessage entry={entry} />;
});

export const ThinkingIndicator = memo(function ThinkingIndicator({ state }: { state: ThinkingState }) {
  if (state === "thinking") {
    return (
      <div className="flex items-center gap-2 px-1 py-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-sm bg-accent animate-pulse" />
          <span className="h-1.5 w-1.5 rounded-sm bg-accent animate-pulse [animation-delay:0.2s]" />
          <span className="h-1.5 w-1.5 rounded-sm bg-accent animate-pulse [animation-delay:0.4s]" />
        </div>
      </div>
    );
  }

  if (state === "tools") {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-ink-muted">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <LoaderCircle className="h-3 w-3 animate-spin" />
        Running tools…
      </div>
    );
  }

  if (state === "background") {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-ink-muted">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <LoaderCircle className="h-3 w-3 animate-spin" />
        Background tasks running…
      </div>
    );
  }

  return null;
});
