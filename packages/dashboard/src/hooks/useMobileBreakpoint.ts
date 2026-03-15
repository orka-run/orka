import { useSyncExternalStore } from "react";

const MOBILE_QUERY = "(max-width: 1023px)"; // below Tailwind's lg breakpoint (1024px)

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false; // SSR fallback: assume desktop
}

export function useMobileBreakpoint(): { isMobile: boolean } {
  const isMobile = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { isMobile };
}
