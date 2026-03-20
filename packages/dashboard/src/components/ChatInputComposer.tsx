import { LoaderCircle, ArrowUp, Square, RotateCcw, Pause } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InputState } from "../hooks/useInputState";
import { useChatUiStore } from "../stores/chatUiStore";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";

interface ChatInputComposerProps {
  sessionId: string;
  inputState: InputState;
  onSend: (text: string) => Promise<void>;
  sendError?: string | null;
  onClearError?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  onRetry?: () => void;
  onStop?: () => void;
  onCancelTurn?: () => void;
  isRetrying?: boolean;
  isStopping?: boolean;
  isCancellingTurn?: boolean;
}

const STATE_PLACEHOLDERS: Record<InputState, string> = {
  waiting: "Send a follow-up message...",
  busy: "Send a message...",
  disabled: "Session completed",
  not_started: "Session is starting...",
};

export function ChatInputComposer({ sessionId, inputState, onSend, sendError, onClearError, placeholder, autoFocus, onRetry, onStop, onCancelTurn, isRetrying, isStopping, isCancellingTurn }: ChatInputComposerProps) {
  const text = useChatUiStore((s) => s.sessions[sessionId]?.draftText ?? "");
  const [isSending, setIsSending] = useState(false);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const previousInputStateRef = useRef<InputState>(inputState);

  const isEditable = (inputState === "waiting" || inputState === "busy") && !isSending;
  const canSend = isEditable && text.trim().length > 0;

  useEffect(() => {
    const previousInputState = previousInputStateRef.current;
    previousInputStateRef.current = inputState;

    if (previousInputState !== "waiting" && inputState === "waiting" && !isSending) {
      editorRef.current?.focus();
    }
  }, [inputState, isSending]);

  const submitRef = useRef<(() => void) | undefined>(undefined);

  async function submit() {
    const nextText = (editorRef.current?.getText() ?? text).trim();
    if (!isEditable || nextText.length === 0) {
      return;
    }

    setIsSending(true);

    try {
      await onSend(nextText);
      useChatUiStore.getState().update(sessionId, { draftText: "" });
      editorRef.current?.clear();
    } catch {
      // Error display handled by parent via sendError prop
    } finally {
      setIsSending(false);
    }
  }

  submitRef.current = submit;

  const handleSubmit = useCallback(() => {
    void submitRef.current?.();
  }, []);

  const handleChange = useCallback(
    (nextText: string) => {
      useChatUiStore.getState().update(sessionId, { draftText: nextText });
      if (sendError) onClearError?.();
    },
    [sessionId, sendError, onClearError],
  );

  return (
    <div className="border-t border-border bg-surface px-2 py-2">
      <div className="flex items-center gap-2">
        <div
          className={`flex min-h-[34px] min-w-0 flex-1 rounded-sm border bg-surface-alt transition focus-within:ring-1 ${
            !isEditable ? "cursor-not-allowed bg-surface-alt/70" : ""
          } ${
            sendError
              ? "border-status-error/50 focus-within:border-status-error/50 focus-within:ring-status-error/20"
              : "border-border focus-within:border-accent focus-within:ring-accent/20"
          }`}
          style={{ maxHeight: "200px", overflowY: "auto" }}
        >
          <ComposerEditor
            ref={editorRef}
            disabled={!isEditable}
            placeholder={placeholder ?? STATE_PLACEHOLDERS[inputState]}
            {...(autoFocus !== undefined ? { autoFocus } : {})}
            initialText={text}
            onChange={handleChange}
            onSubmit={handleSubmit}
          />
        </div>
        {onCancelTurn && (
          <button
            type="button"
            onClick={onCancelTurn}
            disabled={isCancellingTurn}
            aria-label="Cancel turn"
            title="Cancel current turn (keep session alive)"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-status-warning/30 bg-status-warning/10 text-status-warning transition hover:bg-status-warning/20 disabled:opacity-50"
          >
            {isCancellingTurn ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
        )}
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            aria-label="Stop session"
            title="Stop session"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-status-error/30 bg-status-error/10 text-status-error transition hover:bg-status-error/20 disabled:opacity-50"
          >
            {isStopping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            aria-label="Retry session"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-alt text-ink-secondary transition hover:bg-surface-hover disabled:opacity-50"
          >
            {isRetrying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label="Send message"
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-white transition ${
            canSend
              ? "bg-accent-strong hover:bg-accent"
              : "cursor-not-allowed bg-surface-hover text-ink-muted"
          }`}
        >
          {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
      {sendError ? (
        <p className="mt-1 text-[11px] text-status-error">{sendError}</p>
      ) : null}
    </div>
  );
}
