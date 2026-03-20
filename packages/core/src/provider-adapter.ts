// Architecture inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: apps/server/src/provider/ for original patterns

import type { ProviderRuntimeEvent } from "./provider-events";
import type { BackendKind, PermissionMode, ReasoningEffort } from "./types";

export interface RawProviderLine {
  direction: "in" | "out";
  data: string;
  ts: string;
}

export interface ProviderSessionStartInput {
  threadId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  prompt?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  /** Permission mode for tool execution. "supervised" enables dashboard approval flow. */
  permissionMode?: PermissionMode;
  /** Permission rules for supervised mode — adapter injects as ORKA_PERMISSION_RULES env var. */
  permissionRules?: { autoApprove: string[]; alwaysDeny: string[] };
  /** Set the provider's own session ID (e.g. Claude Code --session-id). */
  providerSessionId?: string;
  /** Resume a previous provider session by its ID (e.g. Claude Code --resume). */
  resumeSessionId?: string;
}

export interface ProviderSendTurnInput {
  input?: string;
  model?: string;
}

export type ProviderApprovalDecision = "approve" | "deny";

export interface ProviderSessionHandle {
  threadId: string;
  provider: BackendKind;
  events: AsyncIterable<ProviderRuntimeEvent>;
  rawEvents?: AsyncIterable<RawProviderLine>;
  meta: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly kind: BackendKind;
  startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle>;
  sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void>;
  interruptTurn(handle: ProviderSessionHandle): Promise<void>;
  /** Inject a message into an active turn without starting a new one.
   *  Only supported by Codex (turn/steer). Claude Code absorbs stdin mid-turn
   *  into the current context — use interruptTurn (SIGINT) instead. */
  steerTurn?(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void>;
  /** Cancel the active turn. Codex uses turn/interrupt; Claude Code uses SIGINT.
   *  Unlike interruptTurn, cancelTurn is exposed as an RPC endpoint for
   *  dashboard/CLI consumers. Adapters that don't implement this fall back
   *  to interruptTurn. */
  cancelTurn?(handle: ProviderSessionHandle): Promise<void>;
  stopSession(handle: ProviderSessionHandle): Promise<void>;
  respondToRequest(
    handle: ProviderSessionHandle,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void>;
  replayRawLog?(threadId: string, lines: RawProviderLine[]): AsyncIterable<ProviderRuntimeEvent>;
}
