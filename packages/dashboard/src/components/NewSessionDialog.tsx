// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type { FormEvent } from "react";
import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import type { BackendKind, SessionMode } from "@orka/core";
import type { WsTransport } from "../lib/wsTransport";
import { useSessionStore } from "../stores/sessionStore";

interface NewSessionDialogProps {
  open: boolean;
  transport: WsTransport;
  defaultProjectPath: string;
  onClose: () => void;
}

export function NewSessionDialog({
  open,
  transport,
  defaultProjectPath,
  onClose,
}: NewSessionDialogProps) {
  const promptId = useId();
  const projectPathId = useId();
  const modelId = useId();
  const spawnSession = useSessionStore((state) => state.spawnSession);
  const storeError = useSessionStore((state) => state.error);
  const [prompt, setPrompt] = useState("");
  const [backend, setBackend] = useState<BackendKind>("codex");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<SessionMode>("interactive");
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setProjectPath((current) => current || defaultProjectPath);
  }, [defaultProjectPath, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose, open]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedPrompt = prompt.trim();
    const trimmedProjectPath = projectPath.trim();
    const trimmedModel = model.trim();

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
      await spawnSession(transport, {
        prompt: trimmedPrompt,
        projectPath: trimmedProjectPath,
        backend,
        mode,
        ...(trimmedModel ? { model: trimmedModel } : {}),
      });

      setPrompt("");
      setModel("");
      setMode("interactive");
      setBackend("codex");
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Failed to spawn session.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">New Session</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Launch a fresh dashboard session with prompt, backend, and mode controls.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-zinc-800 p-2 text-zinc-400 transition hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5 px-6 py-5">
          <div>
            <label htmlFor={promptId} className="mb-2 block text-sm font-medium text-zinc-200">
              Prompt
            </label>
            <textarea
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={6}
              placeholder="Describe the work you want the agent to do"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium text-zinc-200">Backend</p>
              <div className="grid grid-cols-3 gap-2">
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
              <label htmlFor={modelId} className="mb-2 block text-sm font-medium text-zinc-200">
                Model
              </label>
              <input
                id={modelId}
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Optional"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <label htmlFor={projectPathId} className="mb-2 block text-sm font-medium text-zinc-200">
                Project Path
              </label>
              <input
                id={projectPathId}
                type="text"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="/path/to/project"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
              />
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-zinc-200">Mode</p>
              <div className="flex rounded-xl border border-zinc-800 bg-zinc-900 p-1">
                {(["background", "interactive"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMode(option)}
                    className={`rounded-lg px-4 py-2 text-sm transition ${
                      mode === option
                        ? "bg-zinc-100 text-zinc-950"
                        : "text-zinc-400 hover:text-zinc-100"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {localError || storeError ? (
            <div className="rounded-xl border border-red-950 bg-red-950/30 px-4 py-3 text-sm text-red-200">
              {localError ?? storeError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm text-zinc-300 transition hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
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
      className={`rounded-xl border px-3 py-3 text-sm font-medium transition ${
        active
          ? "border-zinc-100 bg-zinc-100 text-zinc-950"
          : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
      }`}
    >
      {label}
    </button>
  );
}
