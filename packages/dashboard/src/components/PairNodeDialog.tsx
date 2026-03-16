import { useEffect, useId, useRef, useState } from "react";
import { X, Check, LoaderCircle, AlertCircle } from "lucide-react";
import { PairingClient, PairingError } from "@orka/core/pairing";
import type { PairingClientResult } from "@orka/core/pairing";
import type { PairWithNodeResult } from "@orka/core";
import { parsePairingCode } from "@orka/core/crypto/protocol";
import { driveNoiseHandshake } from "@orka/client";
import { computeKeyId } from "@orka/core/transport/noise-transport";
import { toHex } from "@orka/core/crypto/protocol";
import { saveNoiseKey } from "../lib/noiseKeys";
import { savePairedNode } from "../lib/nodeRegistry";
import { useConnectionSettingsStore } from "../stores/connectionSettingsStore";
import { useMode } from "../hooks/useMode";
import { useTransport } from "../lib/transportContext";

interface PairNodeDialogProps {
  open: boolean;
  onClose: () => void;
}

type PairStep = "idle" | "connecting" | "hello" | "spake2" | "bootstrap" | "noise_verify" | "done";

const STEPS: { key: PairStep; label: string }[] = [
  { key: "connecting", label: "Connecting" },
  { key: "hello", label: "Hello" },
  { key: "spake2", label: "SPAKE2" },
  { key: "bootstrap", label: "Bootstrap" },
  { key: "noise_verify", label: "Noise Verify" },
  { key: "done", label: "Done" },
];

function formatCodeInput(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 21);
  const groups = [
    clean.slice(0, 4),
    clean.slice(4, 8),
    clean.slice(8, 12),
    clean.slice(12, 16),
    clean.slice(16, 21),
  ].filter(Boolean);
  return groups.join("-");
}

export function PairNodeDialog({ open, onClose }: PairNodeDialogProps) {
  const codeInputId = useId();
  const relayUrlId = useId();
  const currentEndpoint = useConnectionSettingsStore((s) => s.endpointUrl);
  const setEndpoint = useConnectionSettingsStore((s) => s.setEndpoint);
  const { mode } = useMode();
  const transport = useTransport();

  const [code, setCode] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [step, setStep] = useState<PairStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PairingClientResult | null>(null);
  const [localResult, setLocalResult] = useState<PairWithNodeResult | null>(null);

  const pairWsRef = useRef<WebSocket | null>(null);
  const verifyWsRef = useRef<WebSocket | null>(null);

  // Pre-fill relay URL and reset state on open
  useEffect(() => {
    if (!open) return;
    if (currentEndpoint) {
      try {
        const url = new URL(currentEndpoint);
        setRelayUrl(`${url.protocol}//${url.host}`);
      } catch {
        setRelayUrl(currentEndpoint);
      }
    }
    setCode("");
    setStep("idle");
    setError(null);
    setResult(null);
    setLocalResult(null);
  }, [open, currentEndpoint]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Cleanup WebSockets on close
  useEffect(() => {
    if (open) return;
    pairWsRef.current?.close();
    pairWsRef.current = null;
    verifyWsRef.current?.close();
    verifyWsRef.current = null;
  }, [open]);

  if (!open) return null;

  function fail(msg: string) {
    setError(msg);
    setStep("idle");
  }

  async function startPairingLocal() {
    setError(null);
    setStep("connecting");

    const trimmedRelay = relayUrl.trim().replace(/\/+$/, "");
    if (!trimmedRelay) {
      fail("Relay URL is required");
      return;
    }

    try {
      const res = await transport.request<PairWithNodeResult>("pairWithNode", {
        pairingCode: code.replace(/-/g, ""),
        relayUrl: trimmedRelay,
      });
      setLocalResult(res);
      setStep("done");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Pairing failed");
    }
  }

  async function startPairingHosted() {
    setError(null);
    setStep("connecting");

    let secret: Uint8Array;
    try {
      const parsed = parsePairingCode(code);
      secret = parsed.secret;
    } catch (e) {
      fail(e instanceof Error ? e.message : "Invalid pairing code");
      return;
    }

    const trimmedRelay = relayUrl.trim().replace(/\/+$/, "");
    if (!trimmedRelay) {
      fail("Relay URL is required");
      return;
    }

    const client = new PairingClient({
      secret,
      relayOrigin: trimmedRelay,
      onSend: (msg) => pairWsRef.current?.send(JSON.stringify(msg)),
    });

    const wsUrl = `${trimmedRelay}/v1/pair/${client.enrollId}`;

    try {
      const ws = new WebSocket(wsUrl);
      pairWsRef.current = ws;

      ws.onopen = () => {
        client.start();
        setStep("hello");
      };

      ws.onmessage = async (event) => {
        try {
          const pairingResult = await client.handleMessage(event.data);

          // Update progress based on client state
          switch (client.state) {
            case "AWAIT_PAIR_RESP":
            case "AWAIT_PAIR_CONFIRM2":
              setStep("spake2");
              break;
            case "AWAIT_PAIR_BOOTSTRAP":
              setStep("bootstrap");
              break;
            case "AWAIT_NOISE_VERIFY":
              setStep("noise_verify");
              break;
          }

          if (pairingResult) {
            await verifyNoise(pairingResult, client, trimmedRelay);
          }
        } catch (e) {
          const msg = e instanceof PairingError
            ? `Pairing failed: ${e.message}`
            : (e instanceof Error ? e.message : "Pairing failed");
          fail(msg);
        }
      };

      ws.onerror = () => fail("WebSocket connection failed");

      ws.onclose = () => {
        if (client.state !== "COMPLETE" && client.state !== "FAILED") {
          client.handleClose();
          if (client.error) fail(client.error.message);
        }
      };
    } catch (e) {
      fail(e instanceof Error ? e.message : "Connection failed");
    }
  }

  function startPairing() {
    if (mode === "local") {
      startPairingLocal();
    } else {
      startPairingHosted();
    }
  }

  async function verifyNoise(
    pairingResult: PairingClientResult,
    client: PairingClient,
    relayOrigin: string,
  ) {
    const nodePath = pairingResult.nodePaths[0];
    if (!nodePath) {
      fail("No node paths in bootstrap");
      return;
    }

    try {
      const verifyWs = new WebSocket(nodePath);
      verifyWsRef.current = verifyWs;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Connection timeout")), 10_000);
        verifyWs.onopen = () => { clearTimeout(timer); resolve(); };
        verifyWs.onerror = () => { clearTimeout(timer); reject(new Error("Failed to connect to node")); };
      });

      const keyId = pairingResult.noiseKeyId || computeKeyId(pairingResult.noiseStaticPubkey);

      await driveNoiseHandshake(verifyWs, {
        nodeId: pairingResult.nodeId,
        serverKey: {
          publicKey: pairingResult.noiseStaticPubkey,
          keyId,
        },
        relayOrigin: "",
      });

      verifyWs.close();
      verifyWsRef.current = null;

      // Noise verified — confirm pairing
      client.confirmNoiseVerified();

      // Save node config
      const pubKeyHex = toHex(pairingResult.noiseStaticPubkey);
      saveNoiseKey(pairingResult.nodeId, { publicKey: pubKeyHex, keyId });
      savePairedNode({
        nodeId: pairingResult.nodeId,
        nodeName: pairingResult.nodeName,
        nodePaths: pairingResult.nodePaths,
        relayOrigin,
        pairedAt: Date.now(),
      });

      setResult(pairingResult);
      setStep("done");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Noise verification failed");
    }
  }

  function handleConnect() {
    if (result) {
      const nodePath = result.nodePaths[0];
      if (nodePath) {
        setEndpoint(nodePath, null, result.nodeId);
      }
    }
    onClose();
  }

  const doneResult = localResult ?? result;
  const isPairing = step !== "idle" && step !== "done";
  const canStart = code.replace(/-/g, "").length >= 20 && relayUrl.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-sm border border-border bg-surface">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">Pair Node</h2>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Enter the code from{" "}
              <code className="rounded-sm border border-border bg-surface-alt px-1 py-0.5 text-[10px] text-ink-secondary">
                orka node pair start
              </code>
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
          {step === "done" && doneResult ? (
            /* Success state */
            <div className="space-y-2">
              <div className="rounded-sm border border-emerald-600/30 bg-emerald-600/5 px-2 py-2">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-700" />
                  <span className="text-[12px] font-medium text-emerald-800">Pairing successful</span>
                </div>
                <div className="mt-2 space-y-1 text-[12px] text-ink-secondary">
                  <p>
                    Node: <span className="text-ink">{doneResult.nodeName}</span>
                  </p>
                  <p>
                    ID: <span className="font-mono text-[11px] text-ink-muted">{doneResult.nodeId}</span>
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                {mode === "local" ? (
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
                  >
                    Done
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      onClick={handleConnect}
                      className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
                    >
                      Connect
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* Form / Progress state */
            <>
              <div>
                <label htmlFor={codeInputId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Pairing Code
                </label>
                <input
                  id={codeInputId}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(formatCodeInput(e.target.value))}
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXXX"
                  disabled={isPairing}
                  className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 font-mono text-[12px] tracking-wider text-ink outline-none transition placeholder:text-ink-muted focus:border-accent disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor={relayUrlId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Relay URL
                </label>
                <input
                  id={relayUrlId}
                  type="text"
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  placeholder="ws://relay:7390"
                  disabled={isPairing}
                  className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent disabled:opacity-50"
                />
              </div>

              {/* Progress indicator */}
              {isPairing && (
                <div className="rounded-sm border border-border bg-surface-alt px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-strong" />
                    {mode === "local" ? (
                      <span className="text-[12px] text-accent-strong">Pairing via daemon...</span>
                    ) : (
                      <span className="text-[12px] text-ink-secondary">
                        <span className="text-accent-strong">
                          {STEPS.find((s) => s.key === step)?.label}
                        </span>
                        <span className="ml-2 text-ink-muted">
                          ({STEPS.findIndex((s) => s.key === step) + 1}/{STEPS.length})
                        </span>
                      </span>
                    )}
                  </div>
                  {mode !== "local" && (
                    <div className="mt-1.5 flex gap-1">
                      {STEPS.map(({ key }, i) => {
                        const currentIndex = STEPS.findIndex((s) => s.key === step);
                        return (
                          <div
                            key={key}
                            className={`h-1 flex-1 rounded-sm transition-colors ${
                              i < currentIndex
                                ? "bg-emerald-600"
                                : i === currentIndex
                                  ? "bg-accent-strong"
                                  : "bg-border"
                            }`}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1.5 text-[12px] text-status-error">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={startPairing}
                  disabled={!canStart || isPairing}
                  className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPairing ? (
                    <span className="flex items-center gap-2">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      Pairing...
                    </span>
                  ) : (
                    "Start Pairing"
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
