import type { DashboardMode } from "../stores/connectionSettingsStore";
import { useConnectionSettingsStore } from "../stores/connectionSettingsStore";

/**
 * Resolve the effective dashboard mode with priority: URL param > env var > store.
 */
export function useMode(): { mode: DashboardMode; locked: boolean } {
  const storeMode = useConnectionSettingsStore((s) => s.mode);

  // 1. URL param override (?mode=hosted or ?mode=local)
  const urlMode = new URLSearchParams(window.location.search).get("mode");
  if (urlMode === "hosted" || urlMode === "local") {
    return { mode: urlMode, locked: true };
  }

  // 2. Build-time env override
  const envMode = import.meta.env["VITE_DASHBOARD_MODE"] as string | undefined;
  if (envMode === "hosted" || envMode === "local") {
    return { mode: envMode, locked: true };
  }

  // 3. Persisted store value
  return { mode: storeMode, locked: false };
}
