import { useState, useRef, useCallback } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import type { BackendKind, NodeInfo, OrchestrationEvent, PermissionMode, SpawnRequest, WorkspaceInfo } from "@orka/core";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import { ComposerToolbar } from "./ComposerToolbar";
import { AdvancedFields } from "./AdvancedFields";
import { useRpcClient } from "../lib/transportContext";
import { useSessionStore } from "../stores/sessionStore";
import { useChatUiStore } from "../stores/chatUiStore";
import { useTimelineCache } from "../lib/timelineCache";
import { withDashboardSpan } from "../lib/tracing";

interface SpawnComposerProps {
  defaultProjectPath: string;
  nodes: NodeInfo[];
  activeWorkspace?: WorkspaceInfo | null;
  onSpawned: () => void;
}

function parseTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

export function SpawnComposer({ defaultProjectPath, nodes, activeWorkspace, onSpawned }: SpawnComposerProps) {
  const client = useRpcClient();
  const spawnSession = useSessionStore((state) => state.spawnSession);

  // Derive defaults from workspace settings
  const wsDefaults = activeWorkspace?.settings?.defaults;
  const defaultBackend = wsDefaults?.backend === "codex" ? "codex" : "claude-code";
  const defaultPermissionMode =
    wsDefaults?.permissionMode === "auto" || wsDefaults?.permissionMode === "bypass"
      ? wsDefaults.permissionMode
      : "supervised";

  // Quick options
  const [backend, setBackend] = useState<BackendKind>(defaultBackend);
  const [model, setModel] = useState(wsDefaults?.model ?? "");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(defaultPermissionMode);

  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState(wsDefaults?.tags?.join(", ") ?? "");
  const [autoMerge, setAutoMerge] = useState(false);
  const [noWorktree, setNoWorktree] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(wsDefaults?.systemPrompt ?? "");
  const [nodeId, setNodeId] = useState("");

  // Spawn state
  const [isSpawning, setIsSpawning] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Editor
  const editorRef = useRef<ComposerEditorHandle>(null);
  const text = useChatUiStore((s) => s.sessions["draft"]?.draftText ?? "");
  const canSend = text.trim().length > 0 && !isSpawning;

  const handleChange = useCallback(
    (nextText: string) => {
      useChatUiStore.getState().update("draft", { draftText: nextText });
      if (spawnError) setSpawnError(null);
    },
    [spawnError],
  );

  async function handleSend() {
    const nextText = (editorRef.current?.getText() ?? text).trim();
    if (!nextText || isSpawning) return;

    setSpawnError(null);
    setPendingMessage(nextText);
    setIsSpawning(true);

    try {
      const trimmedTitle = title.trim();
      const trimmedSystemPrompt = systemPrompt.trim();
      const parsedTags = parseTags(tags);

      const request: SpawnRequest = {
        prompt: nextText,
        projectPath: defaultProjectPath,
        backend,
        permissionMode,
        autoMerge,
        ...(noWorktree ? { noWorktree: true } : {}),
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...(model ? { model } : {}),
        ...(parsedTags.length > 0 ? { tags: parsedTags } : {}),
        ...(trimmedSystemPrompt ? { systemPrompt: trimmedSystemPrompt } : {}),
        ...(nodeId ? { nodeId } : {}),
      };

      const sessionId = await withDashboardSpan(
        "orka.dashboard.draft.spawn",
        {
          "orka.backend": backend,
          "orka.prompt.length": nextText.length,
          "orka.permission_mode": permissionMode,
          "orka.auto_merge": autoMerge,
          "orka.no_worktree": noWorktree,
        },
        async () => {
          return await spawnSession(client, request);
        },
      );

      // Optimistic timeline seed
      const seedEvent: OrchestrationEvent = {
        type: "user.input",
        sessionId,
        text: nextText,
        timestamp: new Date().toISOString(),
      };
      useTimelineCache.getState().set(sessionId, [seedEvent]);

      useChatUiStore.getState().update("draft", { draftText: "" });
      editorRef.current?.clear();
      onSpawned();
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : "Failed to start session");
      setPendingMessage(null);
    } finally {
      setIsSpawning(false);
    }
  }

  const submitRef = useRef<(() => void) | undefined>(undefined);
  submitRef.current = handleSend;
  const handleSubmit = useCallback(() => {
    void submitRef.current?.();
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Pending message (spawning state) */}
      {pendingMessage && (
        <div className="mx-auto w-full max-w-2xl space-y-2 px-3 pt-4">
          <div className="flex justify-end">
            <div className="flex items-start gap-2">
              <div className="min-w-0 bg-accent/5 px-3 py-2 text-[12px] text-ink [overflow-wrap:anywhere]">
                {pendingMessage}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 py-1 text-[12px] text-ink-muted">
            <LoaderCircle className="h-3 w-3 animate-spin" />
            Starting session…
          </div>
        </div>
      )}

      {/* Spacer pushes composer to vertical center when no pending message */}
      <div className="flex-1" />

      {/* Error */}
      {spawnError && (
        <div className="mx-auto w-full max-w-2xl px-3">
          <div className="mb-2 bg-status-error/10 px-3 py-1.5 text-[11px] text-status-error">
            {spawnError}
          </div>
        </div>
      )}

      {/* Composer — full width on mobile, max-w-2xl centered on desktop */}
      <div className="mx-auto w-full max-w-2xl px-3 sm:px-0">
        <div className="border-t border-border bg-surface transition-colors focus-within:border-accent/40 sm:border sm:shadow-sm">
          <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
            <ComposerEditor
              ref={editorRef}
              disabled={isSpawning}
              placeholder="Describe the task…"
              autoFocus
              initialText={text}
              onChange={handleChange}
              onSubmit={handleSubmit}
              className="py-3 px-3"
            />
          </div>

          <ComposerToolbar
            backend={backend}
            onBackendChange={setBackend}
            model={model}
            onModelChange={setModel}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            noWorktree={noWorktree}
            onNoWorktreeChange={setNoWorktree}
            onSend={handleSubmit}
            canSend={canSend}
            isSending={isSpawning}
          />
        </div>

        {/* Advanced — below composer */}
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 px-1 py-1 text-[11px] text-ink-muted transition hover:text-ink-secondary"
        >
          <span>Title, tags, system prompt…</span>
          <ChevronDown className={`h-3 w-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
        </button>
        {showAdvanced && (
          <div className="border border-border/60 bg-surface p-3">
            <AdvancedFields
              title={title}
              onTitleChange={setTitle}
              tags={tags}
              onTagsChange={setTags}
              systemPrompt={systemPrompt}
              onSystemPromptChange={setSystemPrompt}
              autoMerge={autoMerge}
              onAutoMergeChange={setAutoMerge}
              noWorktree={noWorktree}
              onNoWorktreeChange={setNoWorktree}
              nodeId={nodeId}
              onNodeIdChange={setNodeId}
              nodes={nodes}
            />
          </div>
        )}
      </div>

      {/* Bottom spacer — keeps composer centered */}
      <div className="flex-1" />
    </div>
  );
}
