import { useId } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { NodeInfo, PermissionMode } from "@orka/core";

const PERMISSION_MODES: readonly PermissionMode[] = ["bypass", "supervised", "auto"];

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  bypass: "Agent runs without permission checks",
  supervised: "Approve agent actions from dashboard",
  auto: "Agent auto-approves safe operations",
};

interface SpawnAdvancedPanelProps {
  open: boolean;
  onToggle: () => void;
  title: string;
  onTitleChange: (v: string) => void;
  tags: string;
  onTagsChange: (v: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (v: PermissionMode) => void;
  autoMerge: boolean;
  onAutoMergeChange: (v: boolean) => void;
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  nodeId: string;
  onNodeIdChange: (v: string) => void;
  nodes: NodeInfo[];
}

export function SpawnAdvancedPanel({
  open,
  onToggle,
  title,
  onTitleChange,
  tags,
  onTagsChange,
  permissionMode,
  onPermissionModeChange,
  autoMerge,
  onAutoMergeChange,
  systemPrompt,
  onSystemPromptChange,
  nodeId,
  onNodeIdChange,
  nodes,
}: SpawnAdvancedPanelProps) {
  const titleId = useId();
  const tagsId = useId();
  const autoMergeId = useId();
  const systemPromptId = useId();
  const showNodeSelector = nodes.length > 1;

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-3 py-1 text-[11px] text-ink-muted transition hover:text-ink-secondary"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Options
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-2">
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
                className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
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
                className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div>
              <p className="mb-0.5 text-[10px] font-medium text-ink-muted">Permissions</p>
              <div className="inline-flex rounded-sm border border-border bg-surface-alt p-0.5">
                {PERMISSION_MODES.map((pm) => (
                  <button
                    key={pm}
                    type="button"
                    onClick={() => onPermissionModeChange(pm)}
                    className={`rounded-sm px-2 py-0.5 text-[10px] font-medium transition ${
                      permissionMode === pm
                        ? "bg-surface-hover text-ink"
                        : "text-ink-muted hover:text-ink-secondary"
                    }`}
                  >
                    {pm}
                  </button>
                ))}
              </div>
              <p className="mt-0.5 text-[9px] text-ink-muted">
                {PERMISSION_DESCRIPTIONS[permissionMode]}
              </p>
            </div>

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
          </div>

          <div>
            <label htmlFor={systemPromptId} className="mb-0.5 block text-[10px] font-medium text-ink-muted">
              System prompt
            </label>
            <textarea
              id={systemPromptId}
              value={systemPrompt}
              onChange={(e) => onSystemPromptChange(e.target.value)}
              rows={2}
              placeholder="Optional system prompt override"
              className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
            />
          </div>

          {showNodeSelector && (
            <div>
              <p className="mb-0.5 text-[10px] font-medium text-ink-muted">Node</p>
              <div className="inline-flex rounded-sm border border-border bg-surface-alt p-0.5">
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
      )}
    </div>
  );
}
