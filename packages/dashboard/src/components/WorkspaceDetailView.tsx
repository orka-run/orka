import { useState } from "react";
import { Archive, FolderOpen, Layers, Plus, Server } from "lucide-react";
import type { BackendKind, PermissionMode, WorkspaceInfo, WorkspaceSettings } from "@orka/core";
import { formatRelativeTime } from "../lib/sessionUi";

const BACKENDS: readonly BackendKind[] = ["claude-code", "codex"];

const MODELS = [
  { value: "", label: "No default" },
  { value: "claude-opus-4-6", label: "claude-opus-4-6" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" },
];

const PERMISSION_MODES: readonly PermissionMode[] = ["supervised", "bypass", "auto"];

interface WorkspaceDetailViewProps {
  workspace: WorkspaceInfo;
  onNewSession: () => void;
  onUpdateSettings: (settings: WorkspaceSettings) => Promise<void>;
  onArchive: () => Promise<void>;
}

export function WorkspaceDetailView({
  workspace,
  onNewSession,
  onUpdateSettings,
  onArchive,
}: WorkspaceDetailViewProps) {
  const now = Date.now();
  const defaults = workspace.settings?.defaults ?? {};
  const [isArchiving, setIsArchiving] = useState(false);

  function updateDefault(key: string, value: string) {
    const current = workspace.settings?.defaults ?? {};
    const next: WorkspaceSettings = {
      ...workspace.settings,
      defaults: { ...current, [key]: value || undefined },
    };
    void onUpdateSettings(next);
  }

  async function handleArchive() {
    setIsArchiving(true);
    try {
      await onArchive();
    } finally {
      setIsArchiving(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-4 p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              {workspace.metadata?.color ? (
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: workspace.metadata.color }}
                />
              ) : (
                <Layers className="h-4 w-4 text-ink-muted" />
              )}
              <h2 className="text-[16px] font-semibold text-ink">{workspace.name}</h2>
            </div>
            {workspace.metadata?.description ? (
              <p className="mt-1 text-[12px] text-ink-muted">{workspace.metadata.description}</p>
            ) : null}
            <p className="mt-1 text-[11px] text-ink-muted">
              Created {formatRelativeTime(workspace.createdAt, now)} · {workspace.sessionCount} session{workspace.sessionCount !== 1 ? "s" : ""} · {workspace.activeCount} active
            </p>
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" />
            New Session
          </button>
        </div>

        {/* Defaults */}
        <section className="rounded-sm border border-border bg-surface-alt p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Default Settings
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-[11px] font-medium text-ink-secondary">Backend</label>
              <select
                value={defaults.backend ?? ""}
                onChange={(e) => updateDefault("backend", e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1 text-[11px] text-ink outline-none transition focus:border-accent"
              >
                <option value="">No default</option>
                {BACKENDS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ink-secondary">Model</label>
              <select
                value={defaults.model ?? ""}
                onChange={(e) => updateDefault("model", e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1 text-[11px] text-ink outline-none transition focus:border-accent"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-ink-secondary">Permissions</label>
              <select
                value={defaults.permissionMode ?? ""}
                onChange={(e) => updateDefault("permissionMode", e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1 text-[11px] text-ink outline-none transition focus:border-accent"
              >
                <option value="">No default</option>
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Path Mappings */}
        <section className="rounded-sm border border-border bg-surface-alt p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Path Mappings
          </p>
          {workspace.paths.length === 0 ? (
            <p className="mt-2 text-[11px] text-ink-muted">
              No paths configured. Sessions in this workspace match by project path.
            </p>
          ) : (
            <div className="mt-2 space-y-1">
              {workspace.paths.map((p, i) => (
                <div
                  key={`${p.projectPath}-${p.nodeId ?? "local"}-${i}`}
                  className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                    {p.projectPath}
                  </span>
                  {p.nodeId ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm border border-border bg-surface-alt px-1 py-0.5 text-[9px] text-ink-muted">
                      <Server className="h-2.5 w-2.5" />
                      {p.nodeId}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Actions */}
        <div className="flex items-center gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => void handleArchive()}
            disabled={isArchiving}
            className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:border-status-error/30 hover:bg-status-error/10 hover:text-status-error disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5" />
            {workspace.archivedAt ? "Unarchive" : "Archive"}
          </button>
        </div>
      </div>
    </div>
  );
}
