import { useId } from "react";
import type { NodeInfo } from "@orka/core";

interface AdvancedFieldsProps {
  title: string;
  onTitleChange: (v: string) => void;
  tags: string;
  onTagsChange: (v: string) => void;
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  autoMerge: boolean;
  onAutoMergeChange: (v: boolean) => void;
  noWorktree: boolean;
  onNoWorktreeChange: (v: boolean) => void;
  nodeId: string;
  onNodeIdChange: (v: string) => void;
  nodes: NodeInfo[];
}

export function AdvancedFields({
  title,
  onTitleChange,
  tags,
  onTagsChange,
  systemPrompt,
  onSystemPromptChange,
  autoMerge,
  onAutoMergeChange,
  noWorktree,
  onNoWorktreeChange,
  nodeId,
  onNodeIdChange,
  nodes,
}: AdvancedFieldsProps) {
  const titleId = useId();
  const tagsId = useId();
  const systemPromptId = useId();
  const autoMergeId = useId();
  const noWorktreeId = useId();
  const showNodeSelector = nodes.length > 1;

  return (
    <div className="space-y-2 border-t border-border/50 px-3 py-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={titleId} className="mb-0.5 block text-[10px] font-medium text-ink-muted">
            Title
          </label>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Optional"
            className="w-full rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
          />
        </div>
        <div>
          <label htmlFor={tagsId} className="mb-0.5 block text-[10px] font-medium text-ink-muted">
            Tags
          </label>
          <input
            id={tagsId}
            type="text"
            value={tags}
            onChange={(e) => onTagsChange(e.target.value)}
            placeholder="frontend, urgent"
            className="w-full rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
          />
        </div>
      </div>

      <div>
        <label htmlFor={systemPromptId} className="mb-0.5 block text-[10px] font-medium text-ink-muted">
          System prompt
        </label>
        <input
          id={systemPromptId}
          type="text"
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          placeholder="Optional system prompt override"
          className="w-full rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label htmlFor={autoMergeId} className="flex cursor-pointer items-center gap-1.5">
          <input
            id={autoMergeId}
            type="checkbox"
            checked={autoMerge}
            onChange={(e) => onAutoMergeChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded-sm border-border bg-surface accent-accent-strong"
          />
          <span className="text-[10px] font-medium text-ink-secondary">Auto-merge</span>
        </label>

        <label htmlFor={noWorktreeId} className="flex cursor-pointer items-center gap-1.5">
          <input
            id={noWorktreeId}
            type="checkbox"
            checked={noWorktree}
            onChange={(e) => onNoWorktreeChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded-sm border-border bg-surface accent-accent-strong"
          />
          <span className="text-[10px] font-medium text-ink-secondary">No worktree</span>
        </label>

        {showNodeSelector && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-ink-muted">Node:</span>
            <div className="inline-flex rounded-md border border-border bg-surface-alt p-0.5">
              <button
                type="button"
                onClick={() => onNodeIdChange("")}
                className={`rounded-sm px-2 py-0.5 text-[10px] font-medium transition ${
                  nodeId === ""
                    ? "bg-surface-hover text-ink"
                    : "text-ink-muted hover:text-ink-secondary"
                }`}
              >
                auto
              </button>
              {nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onNodeIdChange(node.id)}
                  className={`rounded-sm px-2 py-0.5 text-[10px] font-medium transition ${
                    nodeId === node.id
                      ? "bg-surface-hover text-ink"
                      : "text-ink-muted hover:text-ink-secondary"
                  }`}
                >
                  {node.id}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
