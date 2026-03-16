import { create } from "zustand";

const SOUND_ENABLED_KEY = "orka:soundEnabled";

function loadSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SOUND_ENABLED_KEY);
    return stored !== "false"; // default true
  } catch {
    return true;
  }
}

export interface NotificationState {
  permission: NotificationPermission;
  soundEnabled: boolean;
  pendingCount: number;
  /** Whether the permission banner has been dismissed this session */
  bannerDismissed: boolean;
  requestPermission: () => Promise<void>;
  toggleSound: () => void;
  incrementPending: () => void;
  decrementPending: () => void;
  setPendingCount: (count: number) => void;
  dismissBanner: () => void;
}

function getPermission(): NotificationPermission {
  if (!("Notification" in window)) return "denied";
  return Notification.permission;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  permission: getPermission(),
  soundEnabled: loadSoundEnabled(),
  pendingCount: 0,
  bannerDismissed: false,
  requestPermission: async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    set({ permission: result });
  },
  toggleSound: () => {
    set((state) => {
      const next = !state.soundEnabled;
      try {
        localStorage.setItem(SOUND_ENABLED_KEY, String(next));
      } catch {
        // localStorage unavailable
      }
      return { soundEnabled: next };
    });
  },
  incrementPending: () => set((state) => ({ pendingCount: state.pendingCount + 1 })),
  decrementPending: () => set((state) => ({ pendingCount: Math.max(0, state.pendingCount - 1) })),
  setPendingCount: (count) => set({ pendingCount: count }),
  dismissBanner: () => set({ bannerDismissed: true }),
}));
