import { useEffect, useId, useState } from "react";
import { Monitor, Globe, X } from "lucide-react";
import { useConnectionSettingsStore } from "../stores/connectionSettingsStore";
import type { DashboardMode } from "../stores/connectionSettingsStore";
import { useMode } from "../hooks/useMode";

interface ConnectionSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectionSettingsDialog({ open, onClose }: ConnectionSettingsDialogProps) {
  const endpointUrlId = useId();
  const authTokenId = useId();
  const currentUrl = useConnectionSettingsStore((s) => s.endpointUrl);
  const currentToken = useConnectionSettingsStore((s) => s.authToken);
  const setEndpoint = useConnectionSettingsStore((s) => s.setEndpoint);
  const setStoreMode = useConnectionSettingsStore((s) => s.setMode);
  const { mode, locked } = useMode();
  const [url, setUrl] = useState(currentUrl ?? "");
  const [token, setToken] = useState(currentToken ?? "");
  const [localMode, setLocalMode] = useState<DashboardMode>(mode);

  useEffect(() => {
    if (open) {
      setUrl(currentUrl ?? "");
      setToken(currentToken ?? "");
      setLocalMode(mode);
    }
  }, [open, currentUrl, currentToken, mode]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isCustom = currentUrl !== null;
  const isHosted = localMode === "hosted";

  function handleSave() {
    if (!locked) {
      setStoreMode(localMode);
    }
    if (isHosted) {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) return;
      setEndpoint(trimmedUrl, token.trim() || null);
    }
    onClose();
  }

  function handleDisconnect() {
    setEndpoint(null, null);
    setUrl("");
    setToken("");
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-sm border border-border bg-surface">
        <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">Connection Settings</h2>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Choose how the dashboard connects to Orka.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border p-1 text-ink-muted transition hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 px-3 py-2">
          {/* Mode toggle */}
          <div className="flex gap-1">
            <button
              type="button"
              disabled={locked}
              onClick={() => setLocalMode("local")}
              className={`flex flex-1 items-center gap-2 rounded-sm border px-2 py-1.5 text-[12px] transition ${
                localMode === "local"
                  ? "border-accent/50 bg-accent/10 text-accent-strong"
                  : "border-border bg-surface-alt text-ink-muted hover:text-ink-secondary"
              } ${locked ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <Monitor className="h-4 w-4 shrink-0" />
              <div className="text-left">
                <div className="font-medium">Local Daemon</div>
                <div className="text-[10px] opacity-70">Daemon manages connections</div>
              </div>
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => setLocalMode("hosted")}
              className={`flex flex-1 items-center gap-2 rounded-sm border px-2 py-1.5 text-[12px] transition ${
                localMode === "hosted"
                  ? "border-accent/50 bg-accent/10 text-accent-strong"
                  : "border-border bg-surface-alt text-ink-muted hover:text-ink-secondary"
              } ${locked ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <Globe className="h-4 w-4 shrink-0" />
              <div className="text-left">
                <div className="font-medium">Direct to Relay</div>
                <div className="text-[10px] opacity-70">Browser connects directly</div>
              </div>
            </button>
          </div>

          {locked ? (
            <p className="text-[10px] text-ink-muted">
              Mode is locked by {new URLSearchParams(window.location.search).get("mode") ? "URL parameter" : "build configuration"}.
            </p>
          ) : null}

          {isHosted ? (
            <>
              <div>
                <label htmlFor={endpointUrlId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Relay URL
                </label>
                <input
                  id={endpointUrlId}
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="ws://relay:7390/ws"
                  className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
                />
              </div>

              <div>
                <label htmlFor={authTokenId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Auth Token
                </label>
                <input
                  id={authTokenId}
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
                />
              </div>

              {isCustom ? (
                <div className="rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink-muted">
                  Connected to <span className="text-ink-secondary">{currentUrl}</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink-muted">
              Connected to local daemon. The daemon manages relay connections, encryption, and node pairing.
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {isHosted && isCustom ? (
              <button
                type="button"
                onClick={handleDisconnect}
                className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
              >
                Use Default
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isHosted && !url.trim()}
              className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isHosted ? "Connect" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
