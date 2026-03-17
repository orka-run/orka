// Draft chat view: unified spawn UX with inline advanced options
import { useState } from "react";
import { Bot, LoaderCircle, MessageSquarePlus, User } from "lucide-react";
import type { BackendKind, NodeInfo, PermissionMode, SessionMode, SpawnRequest } from "@orka/core";
import { ChatInputComposer } from "./ChatInputComposer";
import { SpawnAdvancedPanel } from "./SpawnAdvancedPanel";
import { useTransport } from "../lib/transportContext";
import { useSessionStore } from "../stores/sessionStore";
import { useTimelineCache } from "../lib/timelineCache";
import { withDashboardSpan } from "../lib/tracing";

interface DraftChatViewProps {
  defaultProjectPath: string;
  nodes: NodeInfo[];
  onSpawned: () => void;
}

const MODELS = [
  { value: "", label: "Default model" },
  { value: "claude-opus-4-6", label: "claude-opus-4-6" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" },
];

const BACKENDS: readonly BackendKind[] = ["claude-code", "codex", "shell"];
const MODES: readonly SessionMode[] = ["background", "interactive"];

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

export function DraftChatView({ defaultProjectPath, nodes, onSpawned }: DraftChatViewProps) {
  const transport = useTransport();
  const spawnSession = useSessionStore((state) => state.spawnSession);

  // Quick options (always visible)
  const [backend, setBackend] = useState<BackendKind>("claude-code");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<SessionMode>("background");

  // Advanced options (collapsible)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("supervised");
  const [autoMerge, setAutoMerge] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [nodeId, setNodeId] = useState("");

  // Spawn state
  const [isSpawning, setIsSpawning] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  async function handleSend(text: string) {
    setSpawnError(null);
    setPendingMessage(text);
    setIsSpawning(true);

    try {
      const trimmedTitle = title.trim();
      const trimmedSystemPrompt = systemPrompt.trim();
      const parsedTags = parseTags(tags);

      const request: SpawnRequest = {
        prompt: text,
        projectPath: defaultProjectPath,
        backend,
        mode,
        permissionMode,
        autoMerge,
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
          "orka.mode": mode,
          "orka.prompt.length": text.length,
          "orka.permission_mode": permissionMode,
          "orka.auto_merge": autoMerge,
        },
        async () => {
          return await spawnSession(transport, request);
        },
      );

      // Optimistic timeline seed: show user's prompt instantly in ChatView
      useTimelineCache.getState().set(sessionId, [{
        type: "user.input",
        sessionId,
        text,
        timestamp: new Date().toISOString(),
      } as any]);

      onSpawned();
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : "Failed to start session");
      setPendingMessage(null);
    } finally {
      setIsSpawning(false);
    }
  }

  const inputState = isSpawning ? ("busy" as const) : ("waiting" as const);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <MiniPills options={BACKENDS} value={backend} onChange={setBackend} />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-sm border border-border bg-surface-alt px-2 py-1 text-[11px] text-ink-secondary outline-none transition focus:border-accent"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <MiniPills options={MODES} value={mode} onChange={setMode} />
        </div>
      </header>

      <SpawnAdvancedPanel
        open={showAdvanced}
        onToggle={() => setShowAdvanced((v) => !v)}
        title={title}
        onTitleChange={setTitle}
        tags={tags}
        onTagsChange={setTags}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        autoMerge={autoMerge}
        onAutoMergeChange={setAutoMerge}
        systemPrompt={systemPrompt}
        onSystemPromptChange={setSystemPrompt}
        nodeId={nodeId}
        onNodeIdChange={setNodeId}
        nodes={nodes}
      />

      <div className="flex-1 overflow-hidden p-3">
        <div className="flex h-full flex-col overflow-hidden rounded-sm border border-border bg-surface">
          <div className="flex flex-1 items-center justify-center overflow-y-auto px-2">
            {pendingMessage ? (
              <div className="w-full max-w-3xl space-y-2 self-start pt-4">
                <div className="flex justify-end">
                  <div className="flex max-w-3xl items-start gap-2">
                    <div className="min-w-0 rounded-sm rounded-tr-none border border-accent/20 bg-accent/5 px-2 py-1.5 [overflow-wrap:anywhere]">
                      <p className="text-[12px] text-ink">{pendingMessage}</p>
                    </div>
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
                      <User className="h-3.5 w-3.5" />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-1 py-1">
                  <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
                    <Bot className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex items-center gap-1 text-[12px] text-ink-muted">
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                    Starting session…
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-sm bg-surface-alt">
                  <MessageSquarePlus className="h-5 w-5 text-ink-muted" />
                </div>
                <p className="text-[13px] font-medium text-ink-secondary">New session</p>
                <p className="mt-1 text-[11px] text-ink-muted">
                  Send a message to start a new session
                </p>
              </div>
            )}
          </div>
          <ChatInputComposer
            sessionId="draft"
            inputState={inputState}
            onSend={handleSend}
            sendError={spawnError}
            onClearError={() => setSpawnError(null)}
            placeholder="Describe the work you want the agent to do…"
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

function MiniPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-sm border border-border bg-surface-alt p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-sm px-2 py-1 text-[11px] font-medium transition ${
            value === opt
              ? "bg-surface-hover text-ink"
              : "text-ink-muted hover:text-ink-secondary"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
