import { useCallback, useEffect, useRef } from "react";
import { useChatUiStore } from "../stores/chatUiStore";

interface UseChatScrollOptions {
  sessionId: string;
  entriesLength: number;
}

export function useChatScroll({ sessionId, entriesLength }: UseChatScrollOptions) {
  const autoScroll = useChatUiStore((state) => state.sessions[sessionId]?.autoScroll ?? true);
  const entriesAtPauseRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && entriesLength > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [autoScroll, entriesLength]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    const currentAutoScroll = useChatUiStore.getState().get(sessionId).autoScroll;

    if (!isAtBottom && currentAutoScroll) {
      entriesAtPauseRef.current = entriesLength;
    }
    if (isAtBottom !== currentAutoScroll) {
      useChatUiStore.getState().update(sessionId, { autoScroll: isAtBottom });
    }
  }, [entriesLength, sessionId]);

  const scrollToBottom = useCallback(() => {
    useChatUiStore.getState().update(sessionId, { autoScroll: true });
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessionId]);

  const newMessagesCount = autoScroll ? 0 : Math.max(0, entriesLength - entriesAtPauseRef.current);

  return {
    autoScroll,
    bottomRef,
    scrollRef,
    handleScroll,
    scrollToBottom,
    newMessagesCount,
  };
}
