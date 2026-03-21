import { LoaderCircle, ArrowUp, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InputState } from "../hooks/useInputState";
import { useChatUiStore } from "../stores/chatUiStore";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import type { QuotedText } from "./chat/MessageEntry";

interface ChatInputComposerProps {
  sessionId: string;
  inputState: InputState;
  onSend: (text: string) => Promise<void>;
  sendError?: string | null;
  onClearError?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  onRetry?: () => void;
  onCancelTurn?: () => void;
  isRetrying?: boolean;
  isCancellingTurn?: boolean;
  quotedText?: QuotedText | null;
  onClearQuote?: () => void;
}

const STATE_PLACEHOLDERS: Record<InputState, string> = {
  waiting: "Send a follow-up message...",
  busy: "Send a message...",
  disabled: "Session completed",
  not_started: "Session is starting...",
};

export function ChatInputComposer({ sessionId, inputState, onSend, sendError, onClearError, placeholder, autoFocus, onRetry, onCancelTurn, isRetrying, isCancellingTurn, quotedText, onClearQuote }: ChatInputComposerProps) {
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
    const rawText = (editorRef.current?.getText() ?? text).trim();
    if (!isEditable || rawText.length === 0) {
      return;
    }

    // Prepend quoted text as markdown blockquote
    const nextText = quotedText
      ? `> ${quotedText.text.split("\n").join("\n> ")}\n\n${rawText}`
      : rawText;

    setIsSending(true);

    try {
      await onSend(nextText);
      useChatUiStore.getState().update(sessionId, { draftText: "" });
      editorRef.current?.clear();
      onClearQuote?.();
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
      {quotedText ? (
        <div className="mb-1.5 flex items-start gap-1.5 rounded-sm border-l-2 border-accent bg-surface-alt px-2 py-1">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium text-ink-muted">
              Replying to {quotedText.source}
            </p>
            <p className="line-clamp-2 text-[11px] text-ink-secondary">
              {quotedText.text}
            </p>
          </div>
          <button
            type="button"
            onClick={onClearQuote}
            aria-label="Clear quote"
            className="mt-0.5 shrink-0 rounded-sm p-0.5 text-ink-muted transition hover:bg-surface-hover hover:text-ink-secondary"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
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
            className="px-2.5 py-1.5"
          />
        </div>
        {onCancelTurn && (
          <button
            type="button"
            onClick={onCancelTurn}
            disabled={isCancellingTurn}
            aria-label="Cancel turn"
            title="Interrupt current response"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-status-error/30 bg-status-error/10 text-status-error transition hover:bg-status-error/20 disabled:opacity-50"
          >
            {isCancellingTurn ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
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
