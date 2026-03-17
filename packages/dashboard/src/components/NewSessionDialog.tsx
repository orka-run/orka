// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type { FormEvent } from "react";
import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { BackendKind, NodeInfo, PermissionMode, SessionMode, SpawnRequest } from "@orka/core";
import { withDashboardSpan } from "../lib/tracing";
import type { WsTransport } from "../lib/wsTransport";
import { useSessionStore } from "../stores/sessionStore";

interface NewSessionDialogProps {
  open: boolean;
  transport: WsTransport;
  defaultProjectPath: string;
  nodes: NodeInfo[];
  onClose: () => void;
  onSpawned?: () => void;
  initialValues?: {
    backend?: BackendKind;
    model?: string;
    mode?: SessionMode;
  };
}

export function NewSessionDialog({
  open,
  transport,
  defaultProjectPath,
  nodes,
  onClose,
  onSpawned,
  initialValues,
}: NewSessionDialogProps) {
  const promptId = useId();
  const titleId = useId();
  const projectPathId = useId();
  const modelId = useId();
  const tagsId = useId();
  const autoMergeId = useId();
  const systemPromptId = useId();
  const spawnSession = useSessionStore((state) => state.spawnSession);
  const storeError = useSessionStore((state) => state.error);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [backend, setBackend] = useState<BackendKind>("codex");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<SessionMode>("interactive");
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  const [tags, setTags] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [targetNode, setTargetNode] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("supervised");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const showNodeSelector = nodes.length > 1;

  useEffect(() => {
    if (!open) {
      return;
    }

    setProjectPath((current) => current || defaultProjectPath);
    if (initialValues) {
      if (initialValues.backend) setBackend(initialValues.backend);
      if (initialValues.model !== undefined) setModel(initialValues.model);
      if (initialValues.mode) setMode(initialValues.mode);
    }
  }, [defaultProjectPath, initialValues, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }

      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isSubmitting) {
        event.preventDefault();
        const form = document.querySelector<HTMLFormElement>("[data-spawn-form]");
        form?.requestSubmit();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose, open]);

  if (!open) {
    return null;
  }

  function parseTags(value: string): SpawnRequest["tags"] {
    const parsedTags = Array.from(
      new Set(
        value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    );

    return parsedTags.length > 0 ? parsedTags : undefined;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedPrompt = prompt.trim();
    const trimmedTitle = title.trim();
    const trimmedProjectPath = projectPath.trim();
    const trimmedModel = model.trim();
    const trimmedSystemPrompt = systemPrompt.trim();
    const parsedTags = parseTags(tags);

    if (!trimmedPrompt) {
      setLocalError("Prompt is required.");
      return;
    }

    if (!trimmedProjectPath) {
      setLocalError("Project path is required to spawn a session.");
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);

    try {
      await withDashboardSpan(
        "orka.dashboard.session.spawn",
        {
          "orka.backend": backend,
          "orka.mode": mode,
          "orka.project_path": trimmedProjectPath,
          "orka.auto_merge": autoMerge,
        },
        async (span) => {
          span.addEvent("session.spawn_clicked");

          const request: SpawnRequest = {
            prompt: trimmedPrompt,
            projectPath: trimmedProjectPath,
            backend,
            mode,
            autoMerge,
            ...(trimmedTitle ? { title: trimmedTitle } : {}),
            ...(trimmedModel ? { model: trimmedModel } : {}),
            ...(parsedTags ? { tags: parsedTags } : {}),
            ...(trimmedSystemPrompt ? { systemPrompt: trimmedSystemPrompt } : {}),
            ...(targetNode ? { nodeId: targetNode } : {}),
            ...(permissionMode !== "bypass" ? { permissionMode } : {}),
          };

          await spawnSession(transport, request);
        },
      );

      setPrompt("");
      setTitle("");
      setModel("");
      setMode("interactive");
      setBackend("codex");
      setTags("");
      setAutoMerge(false);
      setSystemPrompt("");
      setTargetNode("");
      setShowAdvanced(false);
      onSpawned?.();
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to spawn session.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-ink/40 backdrop-blur-sm md:items-center md:justify-center md:px-4 md:py-8">
      <div className="flex w-full flex-col overflow-hidden bg-surface max-md:h-full md:max-w-2xl md:rounded-sm md:border md:border-border">
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-3 py-2">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">New Session</h2>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Launch a fresh dashboard session with prompt, backend, and mode controls.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-sm border border-border p-1 text-ink-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} data-spawn-form className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
          <div>
            <label htmlFor={promptId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
              Prompt
            </label>
            <textarea
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
              placeholder="Describe the work you want the agent to do"
              className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor={titleId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
              Title
            </label>
            <input
              id={titleId}
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Optional"
              className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
            />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium text-ink-secondary">Backend</p>
              <div className="grid grid-cols-3 gap-1">
                {(["claude-code", "codex", "shell"] as const).map((option) => (
                  <ToggleButton
                    key={option}
                    active={backend === option}
                    label={option}
                    onClick={() => setBackend(option)}
                  />
                ))}
              </div>
            </div>

            <div>
              <label htmlFor={modelId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                Model
              </label>
              <input
                id={modelId}
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Optional"
                className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
              />
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <label htmlFor={projectPathId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                Project Path
              </label>
              <input
                id={projectPathId}
                type="text"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="/path/to/project"
                className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
              />
            </div>

            <div>
              <p className="mb-1 text-[11px] font-medium text-ink-secondary">Mode</p>
              <div className="grid grid-cols-2 gap-1">
                {(["background", "interactive"] as const).map((option) => (
                  <ToggleButton
                    key={option}
                    active={mode === option}
                    label={option}
                    onClick={() => setMode(option)}
                  />
                ))}
              </div>
            </div>
          </div>

          {showNodeSelector ? (
            <div>
              <p className="mb-1 text-[11px] font-medium text-ink-secondary">Target Node</p>
              <div className="flex flex-wrap gap-1">
                <ToggleButton
                  active={targetNode === ""}
                  label="auto"
                  onClick={() => setTargetNode("")}
                />
                {nodes.map((node) => (
                  <ToggleButton
                    key={node.id}
                    active={targetNode === node.id}
                    label={node.id}
                    onClick={() => setTargetNode(node.id)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <label
            htmlFor={autoMergeId}
            className="flex cursor-pointer items-start gap-2 rounded-sm border border-border bg-surface-alt px-2 py-1.5 transition hover:border-ink-muted"
          >
            <input
              id={autoMergeId}
              type="checkbox"
              checked={autoMerge}
              onChange={(event) => setAutoMerge(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded-sm border-border bg-surface accent-accent-strong"
            />
            <div>
              <p className="text-[12px] font-medium text-ink-secondary">Auto-merge</p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                Automatically merge changes when the session completes successfully.
              </p>
            </div>
          </label>

          <section className="rounded-sm border border-border bg-surface">
            <button
              type="button"
              onClick={() => setShowAdvanced((current) => !current)}
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left"
              aria-expanded={showAdvanced}
            >
              <div>
                <p className="text-[12px] font-medium text-ink-secondary">Advanced</p>
                <p className="mt-0.5 text-[11px] text-ink-muted">Tags and system prompt overrides.</p>
              </div>
              {showAdvanced ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              )}
            </button>

            {showAdvanced ? (
              <div className="space-y-2 border-t border-border px-2 py-2">
                <div>
                  <label htmlFor={tagsId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                    Tags
                  </label>
                  <input
                    id={tagsId}
                    type="text"
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                    placeholder="frontend, urgent, polish"
                    className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
                  />
                </div>

                <div>
                  <label
                    htmlFor={systemPromptId}
                    className="mb-1 block text-[11px] font-medium text-ink-secondary"
                  >
                    System Prompt
                  </label>
                  <textarea
                    id={systemPromptId}
                    value={systemPrompt}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    rows={4}
                    placeholder="Optional"
                    className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-ink-secondary">
                    Permissions
                  </label>
                  <div className="flex gap-1">
                    {(["bypass", "supervised", "auto"] as const).map((pm) => (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => setPermissionMode(pm)}
                        className={`rounded-sm px-2 py-1 text-[11px] transition ${
                          permissionMode === pm
                            ? "bg-surface-hover text-ink font-medium"
                            : "text-ink-muted hover:text-ink-secondary"
                        }`}
                      >
                        {pm === "bypass" ? "Bypass" : pm === "supervised" ? "Supervised" : "Auto"}
                      </button>
                    ))}
                  </div>
                  <p className="mt-0.5 text-[10px] text-ink-muted">
                    {permissionMode === "bypass" && "Agent runs without permission checks"}
                    {permissionMode === "supervised" && "Approve agent actions from dashboard"}
                    {permissionMode === "auto" && "Agent auto-approves safe operations"}
                  </p>
                </div>
              </div>
            ) : null}
          </section>

          {localError || storeError ? (
            <div className="rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1.5 text-[12px] text-status-error">
              {localError ?? storeError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? "Spawning..." : "Spawn Session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm border px-2 py-1.5 text-[12px] font-medium transition ${
        active
          ? "border-ink bg-ink text-surface"
          : "border-border bg-surface-alt text-ink-secondary hover:border-ink-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
