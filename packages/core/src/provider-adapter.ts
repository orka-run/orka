// Architecture inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: apps/server/src/provider/ for original patterns

import type { ProviderRuntimeEvent } from "./provider-events";
import type { BackendKind, ReasoningEffort } from "./types";

export interface ProviderSessionStartInput {
  threadId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  prompt?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
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
  meta: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly kind: BackendKind;
  startSession(input: ProviderSessionStartInput): Promise<ProviderSessionHandle>;
  sendTurn(handle: ProviderSessionHandle, input: ProviderSendTurnInput): Promise<void>;
  interruptTurn(handle: ProviderSessionHandle): Promise<void>;
  stopSession(handle: ProviderSessionHandle): Promise<void>;
  respondToRequest(
    handle: ProviderSessionHandle,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void>;
}
