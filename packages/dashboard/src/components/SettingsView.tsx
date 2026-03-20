import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, RefreshCw, ChevronRight } from "lucide-react";
import type { ConfigResponse, BackendKind, PermissionMode } from "@orka/core";
import { useRpcClient } from "../lib/transportContext";
import { useConnectionStore } from "../stores/connectionStore";
import { useMode } from "../hooks/useMode";

const BACKENDS: readonly BackendKind[] = ["claude-code", "codex"];

const MODELS = [
  { value: "", label: "Default" },
  { value: "claude-opus-4-6", label: "claude-opus-4-6" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" },
];

const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "supervised", "bypass"];

type SectionStatus = "idle" | "saving" | "saved" | "error";

function useSectionStatus(): [SectionStatus, (s: SectionStatus) => void] {
  const [status, setStatus] = useState<SectionStatus>("idle");
  useEffect(() => {
    if (status === "saved") {
      const t = setTimeout(() => setStatus("idle"), 2000);
      return () => clearTimeout(t);
    }
  }, [status]);
  return [status, setStatus];
}

interface SettingsViewProps {
  projectPath?: string;
}

export function SettingsView({ projectPath }: SettingsViewProps) {
  const client = useRpcClient();
  const { mode } = useMode();
  const connectionStatus = useConnectionStore((s) => s.status);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [projectConfig, setProjectConfig] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSection, setExpandedSection] = useState<string | null>("defaults");

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await client.getConfig();
      setConfig(cfg);
      if (projectPath) {
        const projCfg = await client.getProjectConfig(projectPath);
        setProjectConfig(projCfg);
      }
    } catch {
      // Config fetch failed — leave null
    } finally {
      setLoading(false);
    }
  }, [client, projectPath]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
        <p className="text-[12px]">Failed to load configuration</p>
        <button
          type="button"
          onClick={() => void fetchConfig()}
          className="inline-flex items-center gap-1 rounded-sm bg-accent-strong px-2 py-1 text-[11px] font-medium text-white transition hover:bg-accent"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    );
  }

  const toggleSection = (id: string) => {
    setExpandedSection((prev) => (prev === id ? null : id));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-3 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Settings</h2>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Daemon configuration (~/.orka/config.toml)
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchConfig()}
            className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] text-ink-muted transition hover:border-ink-muted hover:text-ink"
          >
            <RefreshCw className="h-3 w-3" />
            Reload
          </button>
        </div>

        {/* Resolution chain info */}
        <div className="rounded-sm border border-border bg-surface-alt px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Config Resolution Order
          </p>
          <p className="mt-1 text-[11px] text-ink-secondary">
            CLI flags &gt; .orka.toml (project) &gt; workspace defaults &gt; ~/.orka/config.toml (global)
          </p>
        </div>

        {/* Defaults Section */}
        <DefaultsSection
          config={config}
          expanded={expandedSection === "defaults"}
          onToggle={() => toggleSection("defaults")}
          onSave={async (values) => {
            await client.updateConfig("defaults", values);
            await fetchConfig();
          }}
        />

        {/* Limits Section */}
        <LimitsSection
          config={config}
          expanded={expandedSection === "limits"}
          onToggle={() => toggleSection("limits")}
          onSave={async (values) => {
            await client.updateConfig("limits", values);
            await fetchConfig();
          }}
        />

        {/* Permissions Section */}
        <PermissionsSection
          config={config}
          expanded={expandedSection === "permissions"}
          onToggle={() => toggleSection("permissions")}
          onSave={async (values) => {
            await client.updateConfig("permissions", values);
            await fetchConfig();
          }}
        />

        {/* Hooks Section */}
        <HooksSection
          config={config}
          expanded={expandedSection === "hooks"}
          onToggle={() => toggleSection("hooks")}
        />

        {/* Project Config (read-only) */}
        {projectPath ? (
          <ProjectConfigSection
            projectPath={projectPath}
            config={projectConfig}
            expanded={expandedSection === "project"}
            onToggle={() => toggleSection("project")}
          />
        ) : null}

        {/* Connection Info */}
        <ConnectionSection
          mode={mode}
          status={connectionStatus}
          expanded={expandedSection === "connection"}
          onToggle={() => toggleSection("connection")}
        />
      </div>
    </div>
  );
}

// --- Section Components ---

function SectionHeader({
  title,
  description,
  expanded,
  onToggle,
}: {
  title: string;
  description: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-sm border border-border bg-surface-alt px-3 py-2 text-left transition hover:bg-surface-alt/80"
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          {title}
        </p>
        <p className="mt-0.5 text-[11px] text-ink-secondary">{description}</p>
      </div>
      <ChevronRight
        className={`h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform ${expanded ? "rotate-90" : ""}`}
      />
    </button>
  );
}

function SaveButton({ status, onClick }: { status: SectionStatus; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={status === "saving"}
      className="inline-flex items-center gap-1 rounded-sm bg-accent-strong px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-accent disabled:opacity-50"
    >
      {status === "saving" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Save className="h-3 w-3" />
      )}
      {status === "saved" ? "Saved" : "Save"}
    </button>
  );
}

const inputClass =
  "w-full rounded-sm border border-border bg-surface px-2 py-1 text-[11px] text-ink outline-none transition focus:border-accent";
const selectClass = inputClass;
const labelClass = "block text-[11px] font-medium text-ink-secondary";

function DefaultsSection({
  config,
  expanded,
  onToggle,
  onSave,
}: {
  config: ConfigResponse;
  expanded: boolean;
  onToggle: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const d = config.defaults;
  const [backend, setBackend] = useState(d.backend);
  const [model, setModel] = useState(d.model);
  const [permissionMode, setPermissionMode] = useState(d.permissionMode);
  const [reasoningEffort, setReasoningEffort] = useState(d.reasoningEffort);
  const [status, setStatus] = useSectionStatus();

  useEffect(() => {
    setBackend(d.backend);
    setModel(d.model);
    setPermissionMode(d.permissionMode);
    setReasoningEffort(d.reasoningEffort);
  }, [d.backend, d.model, d.permissionMode, d.reasoningEffort]);

  const handleSave = async () => {
    setStatus("saving");
    try {
      await onSave({ backend, model, permissionMode, reasoningEffort });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div>
      <SectionHeader
        title="Defaults"
        description="Default backend, model, and spawn settings"
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className="mt-1 rounded-sm border border-border bg-surface-alt p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Backend</label>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
                className={`mt-1 ${selectClass}`}
              >
                {BACKENDS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={`mt-1 ${selectClass}`}
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Permission Mode</label>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
                className={`mt-1 ${selectClass}`}
              >
                <option value="">Default</option>
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Reasoning Effort</label>
              <select
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value)}
                className={`mt-1 ${selectClass}`}
              >
                <option value="">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            {status === "error" ? (
              <span className="text-[11px] text-status-error">Failed to save</span>
            ) : (
              <span />
            )}
            <SaveButton status={status} onClick={() => void handleSave()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LimitsSection({
  config,
  expanded,
  onToggle,
  onSave,
}: {
  config: ConfigResponse;
  expanded: boolean;
  onToggle: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const l = config.limits;
  const [maxConcurrent, setMaxConcurrent] = useState(l.maxConcurrent);
  const [sessionTimeout, setSessionTimeout] = useState(l.sessionTimeoutMinutes);
  const [idleTimeout, setIdleTimeout] = useState(l.idleTimeoutMinutes);
  const [status, setStatus] = useSectionStatus();

  useEffect(() => {
    setMaxConcurrent(l.maxConcurrent);
    setSessionTimeout(l.sessionTimeoutMinutes);
    setIdleTimeout(l.idleTimeoutMinutes);
  }, [l.maxConcurrent, l.sessionTimeoutMinutes, l.idleTimeoutMinutes]);

  const handleSave = async () => {
    setStatus("saving");
    try {
      await onSave({ maxConcurrent, sessionTimeoutMinutes: sessionTimeout, idleTimeoutMinutes: idleTimeout });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div>
      <SectionHeader
        title="Limits"
        description="Concurrency and timeout settings"
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className="mt-1 rounded-sm border border-border bg-surface-alt p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClass}>Max Concurrent</label>
              <input
                type="number"
                min={0}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                className={`mt-1 ${inputClass}`}
              />
              <p className="mt-0.5 text-[10px] text-ink-muted">0 = unlimited</p>
            </div>
            <div>
              <label className={labelClass}>Session Timeout</label>
              <input
                type="number"
                min={1}
                value={sessionTimeout}
                onChange={(e) => setSessionTimeout(Number(e.target.value))}
                className={`mt-1 ${inputClass}`}
              />
              <p className="mt-0.5 text-[10px] text-ink-muted">minutes</p>
            </div>
            <div>
              <label className={labelClass}>Idle Timeout</label>
              <input
                type="number"
                min={1}
                value={idleTimeout}
                onChange={(e) => setIdleTimeout(Number(e.target.value))}
                className={`mt-1 ${inputClass}`}
              />
              <p className="mt-0.5 text-[10px] text-ink-muted">minutes</p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            {status === "error" ? (
              <span className="text-[11px] text-status-error">Failed to save</span>
            ) : (
              <span />
            )}
            <SaveButton status={status} onClick={() => void handleSave()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PermissionsSection({
  config,
  expanded,
  onToggle,
  onSave,
}: {
  config: ConfigResponse;
  expanded: boolean;
  onToggle: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const p = config.permissions;
  const [mode, setMode] = useState(p.mode);
  const [bypassConsent, setBypassConsent] = useState(p.bypassConsent);
  const [status, setStatus] = useSectionStatus();

  useEffect(() => {
    setMode(p.mode);
    setBypassConsent(p.bypassConsent);
  }, [p.mode, p.bypassConsent]);

  const handleSave = async () => {
    setStatus("saving");
    try {
      await onSave({ mode, bypassConsent });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div>
      <SectionHeader
        title="Permissions"
        description="Approval mode and bypass settings"
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className="mt-1 rounded-sm border border-border bg-surface-alt p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Default Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "auto" | "supervised" | "bypass")}
                className={`mt-1 ${selectClass}`}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2 pb-1">
              <label className="flex items-center gap-2 text-[11px] text-ink-secondary">
                <input
                  type="checkbox"
                  checked={bypassConsent}
                  onChange={(e) => setBypassConsent(e.target.checked)}
                  className="rounded-sm"
                />
                Bypass consent acknowledged
              </label>
            </div>
          </div>
          {p.autoApprove.length > 0 ? (
            <div className="mt-2">
              <label className={labelClass}>Auto-approve patterns</label>
              <div className="mt-1 flex flex-wrap gap-1">
                {p.autoApprove.map((pat) => (
                  <span key={pat} className="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
                    {pat}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex items-center justify-between">
            {status === "error" ? (
              <span className="text-[11px] text-status-error">Failed to save</span>
            ) : (
              <span />
            )}
            <SaveButton status={status} onClick={() => void handleSave()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function HooksSection({
  config,
  expanded,
  onToggle,
}: {
  config: ConfigResponse;
  expanded: boolean;
  onToggle: () => void;
}) {
  const h = config.hooks;
  const hasHooks = h.postWorktreeCreate.length > 0 || h.beforeSpawn || h.afterComplete;

  return (
    <div>
      <SectionHeader
        title="Hooks"
        description="Lifecycle hooks (read-only — edit config.toml directly)"
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className="mt-1 rounded-sm border border-border bg-surface-alt p-3">
          {!hasHooks ? (
            <p className="text-[11px] text-ink-muted">No hooks configured</p>
          ) : (
            <div className="space-y-2">
              {h.postWorktreeCreate.length > 0 ? (
                <div>
                  <label className={labelClass}>post_worktree_create</label>
                  {h.postWorktreeCreate.map((cmd, i) => (
                    <pre key={i} className="mt-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-[10px] text-ink-secondary">
                      {cmd}
                    </pre>
                  ))}
                </div>
              ) : null}
              {h.beforeSpawn ? (
                <div>
                  <label className={labelClass}>before_spawn</label>
                  <pre className="mt-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-[10px] text-ink-secondary">
                    {h.beforeSpawn}
                  </pre>
                </div>
              ) : null}
              {h.afterComplete ? (
                <div>
                  <label className={labelClass}>after_complete</label>
                  <pre className="mt-1 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-[10px] text-ink-secondary">
                    {h.afterComplete}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProjectConfigSection({
  projectPath,
  config,
  expanded,
  onToggle,
}: {
  projectPath: string;
  config: ConfigResponse | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <SectionHeader
        title="Project Config"
        description={`${projectPath}/.orka.toml (read-only)`}
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className="mt-1 rounded-sm border border-border bg-surface-alt p-3">
          {!config ? (
            <p className="text-[11px] text-ink-muted">
              No .orka.toml found in project directory
            </p>
          ) : (
            <div className="space-y-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Backend</label>
                  <p className="mt-0.5 text-[11px] text-ink">{config.defaults.backend || "—"}</p>
                </div>
                <div>
                  <label className={labelClass}>Model</label>
                  <p className="mt-0.5 text-[11px] text-ink">{config.defaults.model || "—"}</p>
                </div>
                <div>
                  <label className={labelClass}>Max Concurrent</label>
                  <p className="mt-0.5 text-[11px] text-ink">{config.limits.maxConcurrent}</p>
                </div>
                <div>
                  <label className={labelClass}>Permission Mode</label>
                  <p className="mt-0.5 text-[11px] text-ink">{config.permissions.mode}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionSection({
  mode,
  status,
  expanded,
  onToggle,
}: {
  mode: string;
  status: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <SectionHeader
        title="Connection"
        description="Daemon connection status"
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? (
        <div className="mt-1 rounded-sm border border-border bg-surface-alt p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Mode</label>
              <p className="mt-0.5 text-[11px] text-ink capitalize">{mode}</p>
            </div>
            <div>
              <label className={labelClass}>Status</label>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span
                  className={`inline-block h-2 w-2 rounded-sm ${
                    status === "connected"
                      ? "bg-emerald-600"
                      : status === "connecting" || status === "reconnecting"
                        ? "bg-amber-500"
                        : "bg-status-error"
                  }`}
                />
                <span className="text-[11px] text-ink capitalize">{status}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
