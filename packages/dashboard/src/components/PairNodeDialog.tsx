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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Pair Node</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Enter the code from{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                orka node pair start
              </code>
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
          {step === "done" && doneResult ? (
            /* Success state */
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 px-4 py-4">
                <div className="flex items-center gap-2">
                  <Check className="h-5 w-5 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-200">Pairing successful</span>
                </div>
                <div className="mt-3 space-y-1 text-sm text-zinc-300">
                  <p>
                    Node: <span className="text-zinc-100">{doneResult.nodeName}</span>
                  </p>
                  <p>
                    ID: <span className="font-mono text-xs text-zinc-400">{doneResult.nodeId}</span>
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                {mode === "local" ? (
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400"
                  >
                    Done
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm text-zinc-300 transition hover:text-zinc-100"
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      onClick={handleConnect}
                      className="rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400"
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
                <label htmlFor={codeInputId} className="mb-2 block text-sm font-medium text-zinc-200">
                  Pairing Code
                </label>
                <input
                  id={codeInputId}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(formatCodeInput(e.target.value))}
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXXX"
                  disabled={isPairing}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 font-mono text-sm tracking-wider text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700 disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor={relayUrlId} className="mb-2 block text-sm font-medium text-zinc-200">
                  Relay URL
                </label>
                <input
                  id={relayUrlId}
                  type="text"
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  placeholder="ws://relay:7390"
                  disabled={isPairing}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700 disabled:opacity-50"
                />
              </div>

              {/* Progress indicator */}
              {isPairing && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-400" />
                    {mode === "local" ? (
                      <span className="text-sm text-sky-300">Pairing via daemon...</span>
                    ) : (
                      <span className="text-sm text-zinc-300">
                        <span className="text-sky-300">
                          {STEPS.find((s) => s.key === step)?.label}
                        </span>
                        <span className="ml-2 text-zinc-500">
                          ({STEPS.findIndex((s) => s.key === step) + 1}/{STEPS.length})
                        </span>
                      </span>
                    )}
                  </div>
                  {mode !== "local" && (
                    <div className="mt-2 flex gap-1">
                      {STEPS.map(({ key }, i) => {
                        const currentIndex = STEPS.findIndex((s) => s.key === step);
                        return (
                          <div
                            key={key}
                            className={`h-1 flex-1 rounded-full transition-colors ${
                              i < currentIndex
                                ? "bg-emerald-500"
                                : i === currentIndex
                                  ? "bg-sky-500"
                                  : "bg-zinc-800"
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
                <div className="flex items-start gap-2 rounded-xl border border-red-950 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm text-zinc-300 transition hover:text-zinc-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={startPairing}
                  disabled={!canStart || isPairing}
                  className="rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPairing ? (
                    <span className="flex items-center gap-2">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
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
