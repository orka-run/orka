import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { useConnectionSettingsStore } from "../stores/connectionSettingsStore";

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
  const [url, setUrl] = useState(currentUrl ?? "");
  const [token, setToken] = useState(currentToken ?? "");

  useEffect(() => {
    if (open) {
      setUrl(currentUrl ?? "");
      setToken(currentToken ?? "");
    }
  }, [open, currentUrl, currentToken]);

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

  function handleConnect() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    setEndpoint(trimmedUrl, token.trim() || null);
    onClose();
  }

  function handleDisconnect() {
    setEndpoint(null, null);
    setUrl("");
    setToken("");
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Connection Settings</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Connect to a relay or remote daemon.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-800 p-2 text-zinc-400 transition hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div>
            <label htmlFor={endpointUrlId} className="mb-2 block text-sm font-medium text-zinc-200">
              Endpoint URL
            </label>
            <input
              id={endpointUrlId}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://relay:7390/ws"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
            />
          </div>

          <div>
            <label htmlFor={authTokenId} className="mb-2 block text-sm font-medium text-zinc-200">
              Auth Token
            </label>
            <input
              id={authTokenId}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
            />
          </div>

          {isCustom ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-400">
              Connected to <span className="text-zinc-200">{currentUrl}</span>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 pt-2">
            {isCustom ? (
              <button
                type="button"
                onClick={handleDisconnect}
                className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm text-zinc-300 transition hover:text-zinc-100"
              >
                Use Default
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm text-zinc-300 transition hover:text-zinc-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConnect}
              disabled={!url.trim()}
              className="rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
