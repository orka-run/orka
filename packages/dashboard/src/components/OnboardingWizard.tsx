import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Copy,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
} from "lucide-react";
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
import { useRpcClient } from "../lib/transportContext";
import { DEFAULT_RELAY_URL, DEFAULT_RELAY_NAME } from "../lib/constants";
import { PairingCodeInput, isValidPairingCode } from "./PairingCodeInput";

type ConnectionChoice = "managed" | "selfhosted" | "local";
type WizardPhase = "welcome" | "setup" | "code" | "connecting" | "success";
type PairStep = "connecting" | "hello" | "spake2" | "bootstrap" | "noise_verify" | "done";

const PAIR_STEPS: { key: PairStep; label: string }[] = [
  { key: "connecting", label: "Connected to relay" },
  { key: "hello", label: "Hello exchange" },
  { key: "spake2", label: "SPAKE2 handshake" },
  { key: "bootstrap", label: "Bootstrap received" },
  { key: "noise_verify", label: "Verifying node identity" },
  { key: "done", label: "Saving configuration" },
];

interface OnboardingWizardProps {
  onComplete: () => void;
  onSkip: () => void;
}

export function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const relayUrlId = useId();
  const { mode } = useMode();
  const client = useRpcClient();
  const setEndpoint = useConnectionSettingsStore((s) => s.setEndpoint);

  const [phase, setPhase] = useState<WizardPhase>("welcome");
  const [choice, setChoice] = useState<ConnectionChoice | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [code, setCode] = useState("");
  const [pairStep, setPairStep] = useState<PairStep>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PairingClientResult | null>(null);
  const [localResult, setLocalResult] = useState<PairWithNodeResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const pairWsRef = useRef<WebSocket | null>(null);
  const verifyWsRef = useRef<WebSocket | null>(null);

  // Cleanup WebSockets on unmount
  useEffect(() => {
    return () => {
      pairWsRef.current?.close();
      verifyWsRef.current?.close();
    };
  }, []);

  function reset() {
    setPhase("welcome");
    setChoice(null);
    setRelayUrl(DEFAULT_RELAY_URL);
    setCode("");
    setPairStep("connecting");
    setError(null);
    setResult(null);
    setLocalResult(null);
    pairWsRef.current?.close();
    pairWsRef.current = null;
    verifyWsRef.current?.close();
    verifyWsRef.current = null;
  }

  function handleChoiceClick(c: ConnectionChoice) {
    if (c === "local") {
      onSkip();
      return;
    }
    setChoice(c);
    setRelayUrl(c === "managed" ? DEFAULT_RELAY_URL : "");
    setPhase("setup");
  }

  function handleCopy(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  function fail(msg: string) {
    setError(msg);
    setPhase("code");
  }

  async function startPairingLocal() {
    setError(null);
    setPhase("connecting");
    setPairStep("connecting");

    const trimmedRelay = relayUrl.trim().replace(/\/+$/, "");
    if (!trimmedRelay) {
      fail("Relay URL is required");
      return;
    }

    try {
      const res = await client.pairWithNode({
        pairingCode: code.replace(/-/g, ""),
        relayUrl: trimmedRelay,
      });
      setLocalResult(res);
      setPhase("success");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Pairing failed");
    }
  }

  async function startPairingHosted() {
    setError(null);
    setPhase("connecting");
    setPairStep("connecting");

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
        setPairStep("hello");
      };

      ws.onmessage = async (event) => {
        try {
          const pairingResult = await client.handleMessage(event.data);
          switch (client.state) {
            case "AWAIT_PAIR_RESP":
            case "AWAIT_PAIR_CONFIRM2":
              setPairStep("spake2");
              break;
            case "AWAIT_PAIR_BOOTSTRAP":
              setPairStep("bootstrap");
              break;
            case "AWAIT_NOISE_VERIFY":
              setPairStep("noise_verify");
              break;
          }
          if (pairingResult) {
            await verifyNoise(pairingResult, client, trimmedRelay);
          }
        } catch (e) {
          const msg =
            e instanceof PairingError
              ? `Pairing failed: ${e.message}`
              : e instanceof Error
                ? e.message
                : "Pairing failed";
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
        verifyWs.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        verifyWs.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Failed to connect to node"));
        };
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

      client.confirmNoiseVerified();

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
      setPhase("success");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Noise verification failed");
    }
  }

  function startPairing() {
    if (mode === "local") {
      startPairingLocal();
    } else {
      startPairingHosted();
    }
  }

  function handleDone() {
    const doneResult = localResult ?? result;
    if (doneResult && mode === "hosted" && "nodePaths" in doneResult) {
      const hostedResult = doneResult as PairingClientResult;
      const nodePath = hostedResult.nodePaths[0];
      if (nodePath) {
        setEndpoint(nodePath, null, hostedResult.nodeId);
      }
    }
    onComplete();
  }

  function handleAddAnother() {
    reset();
  }

  const effectiveRelayUrl = choice === "managed" ? DEFAULT_RELAY_URL : relayUrl;
  const serveCmd = `orka serve --relay ${effectiveRelayUrl} --node-id my-server`;
  const pairCmd = "orka node pair start";
  const canStartPairing = isValidPairingCode(code) && relayUrl.trim().length > 0;
  const doneResult = localResult ?? result;

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-lg">
        {/* Welcome screen */}
        {phase === "welcome" && (
          <div className="space-y-4">
            <div className="text-center">
              <h1 className="text-[16px] font-semibold text-ink">Welcome to Orka</h1>
              <p className="mt-1 text-[12px] text-ink-muted">
                Connect your first agent node to get started.
              </p>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => handleChoiceClick("managed")}
                className="group flex w-full items-center gap-3 rounded-sm border border-border bg-surface px-3 py-3 text-left transition hover:border-accent/50 hover:bg-surface-alt"
              >
                <div className="rounded-sm bg-surface-alt p-2 transition group-hover:bg-surface">
                  <Cloud className="h-5 w-5 text-accent-strong" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-ink">
                    Connect via {DEFAULT_RELAY_NAME}
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Managed relay, zero config
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition group-hover:text-accent-strong" />
              </button>

              <button
                type="button"
                onClick={() => handleChoiceClick("selfhosted")}
                className="group flex w-full items-center gap-3 rounded-sm border border-border bg-surface px-3 py-3 text-left transition hover:border-accent/50 hover:bg-surface-alt"
              >
                <div className="rounded-sm bg-surface-alt p-2 transition group-hover:bg-surface">
                  <Server className="h-5 w-5 text-ink-secondary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-ink">Self-hosted relay</div>
                  <div className="text-[11px] text-ink-muted">
                    Use your own relay server
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition group-hover:text-ink-secondary" />
              </button>

              <button
                type="button"
                onClick={() => handleChoiceClick("local")}
                className="group flex w-full items-center gap-3 rounded-sm border border-border bg-surface px-3 py-3 text-left transition hover:border-accent/50 hover:bg-surface-alt"
              >
                <div className="rounded-sm bg-surface-alt p-2 transition group-hover:bg-surface">
                  <Monitor className="h-5 w-5 text-ink-secondary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-ink">Local daemon only</div>
                  <div className="text-[11px] text-ink-muted">
                    No relay, just this machine
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition group-hover:text-ink-secondary" />
              </button>
            </div>

            <div className="text-center">
              <button
                type="button"
                onClick={onSkip}
                className="text-[11px] text-ink-muted transition hover:text-ink-secondary"
              >
                Skip setup
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Server setup instructions */}
        {phase === "setup" && (
          <div className="space-y-4">
            <div>
              <button
                type="button"
                onClick={reset}
                className="mb-2 inline-flex items-center gap-1 text-[11px] text-ink-muted transition hover:text-ink"
              >
                <ArrowLeft className="h-3 w-3" />
                Back
              </button>
              <h2 className="text-[14px] font-semibold text-ink">Set up your server</h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Run these commands on the machine you want to connect.
              </p>
            </div>

            {choice === "selfhosted" && (
              <div>
                <label htmlFor={relayUrlId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Relay URL
                </label>
                <input
                  id={relayUrlId}
                  type="text"
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  placeholder="wss://your-relay.example.com"
                  className="w-full rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-ink-muted focus:border-accent"
                />
              </div>
            )}

            <div className="space-y-2">
              <div>
                <p className="mb-1 text-[11px] text-ink-secondary">1. Start the daemon:</p>
                <div className="flex items-center gap-1">
                  <code className="flex-1 overflow-x-auto rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[11px] text-ink">
                    {serveCmd}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopy(serveCmd, "serve")}
                    className="shrink-0 rounded-sm border border-border p-1.5 text-ink-muted transition hover:text-ink"
                  >
                    {copied === "serve" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              <div>
                <p className="mb-1 text-[11px] text-ink-secondary">2. Start pairing:</p>
                <div className="flex items-center gap-1">
                  <code className="flex-1 overflow-x-auto rounded-sm border border-border bg-surface-alt px-2 py-1.5 text-[11px] text-ink">
                    {pairCmd}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopy(pairCmd, "pair")}
                    className="shrink-0 rounded-sm border border-border p-1.5 text-ink-muted transition hover:text-ink"
                  >
                    {copied === "pair" ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setPhase("code")}
                disabled={choice === "selfhosted" && !relayUrl.trim()}
                className="inline-flex items-center gap-1.5 rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Enter pairing code */}
        {phase === "code" && (
          <div className="space-y-4">
            <div>
              <button
                type="button"
                onClick={() => setPhase("setup")}
                className="mb-2 inline-flex items-center gap-1 text-[11px] text-ink-muted transition hover:text-ink"
              >
                <ArrowLeft className="h-3 w-3" />
                Back
              </button>
              <h2 className="text-[14px] font-semibold text-ink">Enter pairing code</h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Enter the code shown by{" "}
                <code className="rounded-sm border border-border bg-surface-alt px-1 py-0.5 text-[10px]">
                  orka node pair start
                </code>
              </p>
            </div>

            <PairingCodeInput
              value={code}
              onChange={setCode}
              error={error}
            />

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPhase("setup")}
                className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
              >
                Back
              </button>
              <button
                type="button"
                onClick={startPairing}
                disabled={!canStartPairing}
                className="inline-flex items-center gap-1.5 rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                Connect
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Connecting progress */}
        {phase === "connecting" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-[14px] font-semibold text-ink">Connecting to your node...</h2>
            </div>

            <div className="space-y-1">
              {PAIR_STEPS.map(({ key, label }, i) => {
                const currentIndex = PAIR_STEPS.findIndex((s) => s.key === pairStep);
                const isDone = i < currentIndex;
                const isCurrent = i === currentIndex;
                const isPending = i > currentIndex;

                return (
                  <div
                    key={key}
                    className={`flex items-center gap-2 rounded-sm px-2 py-1 text-[12px] ${
                      isDone ? "text-emerald-700" : isCurrent ? "text-accent-strong" : "text-ink-muted"
                    }`}
                  >
                    {isDone ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : isCurrent ? (
                      <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : (
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${isPending ? "bg-border" : ""}`} />
                      </span>
                    )}
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  pairWsRef.current?.close();
                  verifyWsRef.current?.close();
                  setPhase("code");
                }}
                className="rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Success */}
        {phase === "success" && doneResult && (
          <div className="space-y-4">
            <div className="rounded-sm border border-emerald-600/30 bg-emerald-600/5 px-3 py-3">
              <div className="flex items-center gap-2">
                <Check className="h-5 w-5 text-emerald-700" />
                <span className="text-[13px] font-medium text-emerald-800">
                  Node paired successfully!
                </span>
              </div>
              <div className="mt-3 space-y-1 text-[12px] text-ink-secondary">
                <p>
                  Name: <span className="font-medium text-ink">{doneResult.nodeName}</span>
                </p>
                <p>
                  ID:{" "}
                  <span className="font-mono text-[11px] text-ink-muted">
                    {doneResult.nodeId}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleAddAnother}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-[12px] text-ink-secondary transition hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" />
                Add another node
              </button>
              <button
                type="button"
                onClick={handleDone}
                className="rounded-sm bg-accent-strong px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
