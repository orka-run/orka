import { LoaderCircle, ArrowUp, Square, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InputState } from "../hooks/useInputState";

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
  isRetrying?: boolean;
  isStopping?: boolean;
}

const MAX_TEXTAREA_HEIGHT = 200;

const STATE_PLACEHOLDERS: Record<InputState, string> = {
  waiting: "Send a follow-up message...",
  busy: "Agent is working...",
  disabled: "Session completed",
  not_started: "Session is starting...",
};

const STATE_MESSAGES: Record<Exclude<InputState, "waiting">, string> = {
  busy: "Agent is working...",
  disabled: "Session completed",
  not_started: "Session is starting...",
};

export function ChatInputComposer({ sessionId, inputState, onSend, sendError, onClearError, placeholder, autoFocus, onRetry, onStop, isRetrying, isStopping }: ChatInputComposerProps) {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previousInputStateRef = useRef<InputState>(inputState);

  const isEditable = inputState === "waiting" && !isSending;
  const canSend = isEditable && text.trim().length > 0;
  const textareaId = `chat-input-${sessionId}`;

  function resizeTextarea() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }

  useEffect(() => {
    resizeTextarea();
  }, [text]);

  useEffect(() => {
    const previousInputState = previousInputStateRef.current;
    previousInputStateRef.current = inputState;

    if (previousInputState !== "waiting" && inputState === "waiting" && !isSending) {
      textareaRef.current?.focus();
    }
  }, [inputState, isSending]);

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const nextText = text.trim();
    if (!isEditable || nextText.length === 0) {
      return;
    }

    setIsSending(true);

    try {
      await onSend(nextText);
      setText("");
      requestAnimationFrame(() => {
        resizeTextarea();
      });
    } catch {
      // Error display handled by parent via sendError prop
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="border-t border-border bg-surface px-2 py-2">
      <div className="flex items-center gap-2">
        <textarea
          id={textareaId}
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={!isEditable}
          placeholder={placeholder ?? STATE_PLACEHOLDERS[inputState]}
          aria-label="Chat message"
          aria-busy={isSending}
          onChange={(event) => {
            setText(event.target.value);
            if (sendError) onClearError?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.blur();
              return;
            }

            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
              return;
            }

            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          className={`min-h-9 min-w-0 flex-1 resize-none rounded-sm border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:ring-1 disabled:cursor-not-allowed disabled:bg-surface-alt/70 disabled:text-ink-muted ${
            sendError
              ? "border-status-error/50 focus:border-status-error/50 focus:ring-status-error/20"
              : "border-border focus:border-accent focus:ring-accent/20"
          }`}
          style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
        />
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            aria-label="Stop session"
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
      ) : inputState === "busy" ? (
        <p className="mt-1 animate-pulse text-[11px] text-accent-strong">
          {STATE_MESSAGES.busy}
        </p>
      ) : null}
    </div>
  );
}
