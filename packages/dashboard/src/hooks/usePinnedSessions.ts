import { useSyncExternalStore } from "react";

const STORAGE_KEY = "orka-pinned-sessions";

let pinnedSet: Set<string> = loadFromStorage();
let listeners: Array<() => void> = [];

function loadFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((v): v is string => typeof v === "string"));
  } catch {
    // ignore corrupt data
  }
  return new Set();
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...pinnedSet]));
}

function notify() {
  for (const fn of listeners) fn();
}

// Sync across tabs
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      pinnedSet = loadFromStorage();
      notify();
    }
  });
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function getSnapshot() {
  return pinnedSet;
}

export function usePinnedSessions() {
  const ids = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  function toggle(id: string) {
    // Create a new Set so React sees a new reference
    pinnedSet = new Set(pinnedSet);
    if (pinnedSet.has(id)) {
      pinnedSet.delete(id);
    } else {
      pinnedSet.add(id);
    }
    persist();
    notify();
  }

  function isPinned(id: string) {
    return ids.has(id);
  }

  return { pinnedIds: ids, toggle, isPinned };
}
