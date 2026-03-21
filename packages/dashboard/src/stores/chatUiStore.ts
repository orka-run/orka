import { create } from "zustand";

export interface PerSessionChatState {
  scrollTop: number;
  autoScroll: boolean;
  expandedGroups: Set<string>;
  /** Groups the user explicitly collapsed — overrides auto-expand from inProgress tools. */
  collapsedGroups: Set<string>;
  draftText: string;
}

const STORAGE_KEY = "orka-chat-ui-state";
const MAX_SESSIONS = 50;
const DEBOUNCE_MS = 500;

function defaults(): PerSessionChatState {
  return { scrollTop: Infinity, autoScroll: true, expandedGroups: new Set(), collapsedGroups: new Set(), draftText: "" };
}

/** Serializable form for sessionStorage (expandedGroups omitted). */
interface PersistedEntry {
  scrollTop: number;
  autoScroll: boolean;
  draftText: string;
  ts: number;
}

function loadPersisted(): Record<string, PersistedEntry> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, PersistedEntry>;
  } catch {
    return {};
  }
}

function restoreSession(entry: PersistedEntry): PerSessionChatState {
  return {
    scrollTop: entry.scrollTop,
    autoScroll: entry.autoScroll,
    expandedGroups: new Set(),
    collapsedGroups: new Set(),
    draftText: entry.draftText,
  };
}

function initSessions(): Record<string, PerSessionChatState> {
  const persisted = loadPersisted();
  const result: Record<string, PerSessionChatState> = {};
  for (const [id, entry] of Object.entries(persisted)) {
    result[id] = restoreSession(entry);
  }
  return result;
}

export interface ChatUiStore {
  sessions: Record<string, PerSessionChatState>;
  get(sessionId: string): PerSessionChatState;
  update(sessionId: string, patch: Partial<PerSessionChatState>): void;
  clear(sessionId: string): void;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(sessions: Record<string, PerSessionChatState>) {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const now = Date.now();
    const entries: [string, PersistedEntry][] = [];

    for (const [id, s] of Object.entries(sessions)) {
      entries.push([id, { scrollTop: s.scrollTop, autoScroll: s.autoScroll, draftText: s.draftText, ts: now }]);
    }

    // Evict oldest if over limit
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => a[1].ts - b[1].ts);
      entries.splice(0, entries.length - MAX_SESSIONS);
    }

    const obj: Record<string, PersistedEntry> = {};
    for (const [id, entry] of entries) {
      obj[id] = entry;
    }

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // sessionStorage full — ignore
    }
  }, DEBOUNCE_MS);
}

export const useChatUiStore = create<ChatUiStore>((set, get) => ({
  sessions: initSessions(),

  get(sessionId) {
    return get().sessions[sessionId] ?? defaults();
  },

  update(sessionId, patch) {
    set((state) => {
      const current = state.sessions[sessionId] ?? defaults();
      const sessions = { ...state.sessions, [sessionId]: { ...current, ...patch } };
      schedulePersist(sessions);
      return { sessions };
    });
  },

  clear(sessionId) {
    set((state) => {
      if (!(sessionId in state.sessions)) return state;
      const { [sessionId]: _, ...sessions } = state.sessions;
      schedulePersist(sessions);
      return { sessions };
    });
  },
}));
