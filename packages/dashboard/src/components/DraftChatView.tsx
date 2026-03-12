// Draft chat view: empty chat that spawns a session on first message
import { useState } from "react";
import { Bot, LoaderCircle, MessageSquarePlus, Settings2, User } from "lucide-react";
import type { BackendKind, SessionMode, SpawnRequest } from "@orka/core";
import { ChatInputComposer } from "./ChatInputComposer";
import { useTransport } from "../lib/transportContext";
import { useSessionStore } from "../stores/sessionStore";
import { withDashboardSpan } from "../lib/tracing";

export interface DraftSettings {
  backend: BackendKind;
  model: string;
  mode: SessionMode;
}

interface DraftChatViewProps {
  defaultProjectPath: string;
  onSpawned: () => void;
  onOpenAdvanced: (settings: DraftSettings) => void;
}

const MODELS = [
  { value: "", label: "Default model" },
  { value: "claude-opus-4-6", label: "claude-opus-4-6" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" },
];

const BACKENDS: readonly BackendKind[] = ["claude-code", "codex", "shell"];
const MODES: readonly SessionMode[] = ["background", "interactive"];

export function DraftChatView({ defaultProjectPath, onSpawned, onOpenAdvanced }: DraftChatViewProps) {
  const transport = useTransport();
  const spawnSession = useSessionStore((state) => state.spawnSession);

  const [backend, setBackend] = useState<BackendKind>("claude-code");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<SessionMode>("background");
  const [isSpawning, setIsSpawning] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  async function handleSend(text: string) {
    setSpawnError(null);
    setPendingMessage(text);
    setIsSpawning(true);

    try {
      const request: SpawnRequest = {
        prompt: text,
        projectPath: defaultProjectPath,
        backend,
        mode,
        autoMerge: false,
        ...(model ? { model } : {}),
      };

      await withDashboardSpan(
        "orka.dashboard.draft.spawn",
        {
          "orka.backend": backend,
          "orka.mode": mode,
          "orka.prompt.length": text.length,
        },
        async () => {
          await spawnSession(transport, request);
        },
      );

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
      <header className="border-b border-zinc-800 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <MiniPills options={BACKENDS} value={backend} onChange={setBackend} />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 outline-none transition focus:border-zinc-700"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <MiniPills options={MODES} value={mode} onChange={setMode} />
          <button
            type="button"
            onClick={() => onOpenAdvanced({ backend, model, mode })}
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Advanced…
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden p-6">
        <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/70">
          <div className="flex flex-1 items-center justify-center overflow-y-auto px-4">
            {pendingMessage ? (
              <div className="w-full max-w-3xl space-y-4 self-start pt-8">
                <div className="flex justify-end">
                  <div className="flex max-w-3xl items-start gap-3">
                    <div className="min-w-0 rounded-2xl rounded-tr-md border border-indigo-900/50 bg-zinc-900 px-4 py-3 [overflow-wrap:anywhere]">
                      <p className="text-sm text-zinc-100">{pendingMessage}</p>
                    </div>
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-300">
                      <User className="h-4 w-4" />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-1 py-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    Starting session…
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800/80">
                  <MessageSquarePlus className="h-6 w-6 text-zinc-400" />
                </div>
                <p className="text-lg font-medium text-zinc-300">New session</p>
                <p className="mt-2 text-sm text-zinc-500">
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
    <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
            value === opt
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
