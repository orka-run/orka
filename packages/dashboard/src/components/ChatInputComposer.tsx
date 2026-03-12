import { LoaderCircle, ArrowUp } from "lucide-react";
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

export function ChatInputComposer({ sessionId, inputState, onSend, sendError, onClearError, placeholder, autoFocus }: ChatInputComposerProps) {
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
    <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-4">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
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
            className={`min-h-11 w-full resize-none rounded-lg border bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-900/70 disabled:text-zinc-500 ${
              sendError
                ? "border-red-500/70 focus:border-red-500/70 focus:ring-red-500/20"
                : "border-zinc-800 focus:border-sky-500/70 focus:ring-sky-500/20"
            }`}
            style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
          />
          {sendError ? (
            <p className="mt-2 text-xs text-red-400">{sendError}</p>
          ) : inputState !== "waiting" ? (
            <p className={`mt-2 text-xs ${inputState === "busy" ? "animate-pulse text-sky-300" : "text-zinc-500"}`}>
              {STATE_MESSAGES[inputState]}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label="Send message"
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white transition ${
            canSend
              ? "bg-sky-500 hover:bg-sky-400"
              : "cursor-not-allowed bg-zinc-700 text-zinc-300"
          }`}
        >
          {isSending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
