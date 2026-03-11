import { create } from "zustand";

export interface DraftState {
  text: string;
  backend: string;
  model: string;
}

export interface ComposerState {
  drafts: Map<string, DraftState>;
  getDraft: (sessionId: string) => DraftState;
  updateDraft: (sessionId: string, partial: Partial<DraftState>) => void;
  clearDraft: (sessionId: string) => void;
}

const DEFAULT_DRAFT: DraftState = {
  text: "",
  backend: "",
  model: "",
};

export const useComposerStore = create<ComposerState>((set, get) => ({
  drafts: new Map(),
  getDraft: (sessionId) => get().drafts.get(sessionId) ?? { ...DEFAULT_DRAFT },
  updateDraft: (sessionId, partial) =>
    set((state) => {
      const drafts = new Map(state.drafts);
      const current = drafts.get(sessionId) ?? DEFAULT_DRAFT;
      drafts.set(sessionId, { ...current, ...partial });
      return { drafts };
    }),
  clearDraft: (sessionId) =>
    set((state) => {
      if (!state.drafts.has(sessionId)) {
        return state;
      }

      const drafts = new Map(state.drafts);
      drafts.delete(sessionId);
      return { drafts };
    }),
}));
