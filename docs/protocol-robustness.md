# Protocol Robustness Review

## Scope

Reviewed:

- `CLAUDE.md`
- `packages/core/src/provider-events.ts`
- `packages/core/src/orchestration.ts`
- `packages/daemon/src/orchestration/ingestion.ts`
- `packages/daemon/src/db.ts`
- `packages/dashboard/src/components/ChatView.tsx`
- `packages/daemon/src/rpc-handler.ts`
- `packages/core/src/service.ts`

The current runtime path is:

1. Provider adapters emit `ProviderRuntimeEvent`.
2. `mapProviderEvent()` converts provider events into `OrchestrationEvent`.
3. The orchestration engine persists the mapped event and broadcasts it.
4. SQLite stores the event payload as JSON text.
5. RPC returns timeline arrays without event-shape validation.
6. The dashboard consumes those events with a set of reducer-style switches.

The main theme is that the control plane is fairly strict, but the event plane is only partially validated. That makes some incompatibilities fail fast and others fail late or silently.

## 1. Current brittleness points

### 1.1 Where zod enums reject unknown values

Active rejection points:

- `packages/daemon/src/db.ts`
  - `TaskRowSchema`, `SessionRowSchema`, and `UsageLogRowSchema` parse `backend`, `mode`, and `status` with closed enums from `packages/core/src/types.ts`.
  - Unknown `backend` or `status` values in SQLite rows throw during `rowToTask()`, `rowToSession()`, or `rowToUsageRecord()`.
- `packages/core/src/push-protocol.ts`
  - `PushChannelSchema` is a closed enum.
  - `packages/daemon/src/server.ts` validates subscribe/unsubscribe control messages with `PushControlRequestSchema.safeParse()`.
  - A client that tries to subscribe to a new channel an old daemon does not know will not get a structured push error. The control message falls through into RPC handling and ends up as JSON-RPC `-32601 Method not found`.

Latent rejection points:

- `packages/core/src/provider-events.ts` defines closed zod enums for:
  - `CanonicalItemTypeSchema`
  - `CanonicalRequestTypeSchema`
  - `RuntimeSessionStateSchema`
  - `RuntimeTurnStateSchema`
  - `RuntimeItemStatusSchema`
  - `RuntimeContentStreamKindSchema`
- In the reviewed path, those schemas are not used to parse event envelopes at runtime. They currently constrain TypeScript types, not the wire or DB boundary.
- That means unknown provider values are mostly handled by adapter mapping code today, not by zod. If these schemas are later used directly for event parsing, they will become hard rejection points immediately.

### 1.2 Where switch statements miss new cases silently vs crash

Silent drop / ignore:

- `packages/daemon/src/orchestration/ingestion.ts`
  - `mapProviderEvent()` returns `null` in its `default` branch.
  - `packages/daemon/src/orchestration/engine.ts` treats that as a skipped event.
  - Result: a new provider event type can be completely lost: not persisted, not pushed, not visible in the dashboard.
- `packages/dashboard/src/components/ChatView.tsx`
  - `deriveThinkingState()` ignores unknown event types via `default: continue`.
  - `eventsToEntries()` ignores unknown event types via `default: break`.
  - Result: an old dashboard usually degrades by omission rather than crashing.
- `packages/dashboard/src/hooks/useInputState.ts`
  - `deriveInputState()` ignores unknown event types via `default: break`.
  - Result: composer state can become stale if a new event type should influence busy/waiting behavior.
- `packages/daemon/src/orchestration/engine.ts`
  - `projectSessionState()` has no `default` case. At runtime, if an unknown event shape gets in from SQLite or RPC, it is effectively ignored.

Potentially wrong-state behavior:

- `packages/daemon/src/orchestration/engine.ts`
  - `mapRuntimeState()` has no `default` return.
  - Today TypeScript treats it as exhaustive because `RuntimeSessionState` is closed.
  - If an unknown state string arrives from old data, relaxed parsing, or manual DB edits, the function returns `undefined` at runtime and can corrupt `projection.status`.

Explicit fail-fast:

- `packages/daemon/src/rpc-handler.ts`
  - `dispatch()` has an explicit `default` branch that throws `RPC_METHOD_NOT_FOUND`.
  - Unknown RPC methods fail clearly instead of being ignored.

### 1.3 Old dashboard, new daemon, new event types

What happens today:

- `ChatView` fetches `getSessionTimeline` and casts the result to `OrchestrationEvent[]` without validating event shape.
- The live subscription path also casts push payloads to `OrchestrationEvent` without validation.
- Unknown event types are appended to local state and then mostly ignored by reducers.

Observed compatibility behavior:

- New event type:
  - Usually silently ignored in chat rendering, thinking-state derivation, and input-state derivation.
  - No crash unless downstream code assumes a field exists for a known `type`.
- New enum value on an existing event:
  - `content.delta.streamKind`: old dashboard only renders `assistant_text` and `reasoning_text`; new stream kinds are dropped from the transcript.
  - `itemType`: unknown values still render, but `itemIcon()` falls back to `"command"`.
  - `requestType`: approval cards use a generic fallback label, so this is already reasonably robust.

Net effect:

- Additive event types are mostly safe but lossy.
- Additive values on existing fields are mixed: some degrade well, some are silently hidden.
- Shape changes inside an existing event are risky because the dashboard trusts the payload.

### 1.4 Old SQLite events, new code

Storage is currently permissive:

- `packages/daemon/src/db.ts` stores orchestration events as raw JSON text in `payload`.
- On read, `rowToOrchestrationEvent()` only validates that `payload` is a string, then does `JSON.parse(payload) as OrchestrationEvent`.
- There is no event schema validation, no version field, and no migration layer for event payloads.

What that means:

- Old events with extra fields are fine.
- Old events with unknown `type` values do not fail on DB read; they fail later only if a consumer assumes more than it should.
- Old events with unknown enum values on known event types also do not fail on DB read.
- Malformed JSON does fail immediately when the timeline is read.
- A semantic change to a known field can produce wrong behavior instead of an obvious failure.

This is simultaneously flexible and brittle:

- Flexible because old JSON blobs remain readable.
- Brittle because compatibility problems are discovered late, deep in projections or UI reducers.

### 1.5 RPC method additions

Current behavior is straightforward:

- If a client calls a method the daemon does not implement, `packages/daemon/src/rpc-handler.ts` returns JSON-RPC `-32601 Method not found`.
- `RemoteClient` and dashboard transport convert that into a generic `Error(message)`.
- There is no method negotiation, feature capability discovery, or version compatibility check in `OrkaService`.

Implication:

- Adding a method is server-safe.
- Using a new method against an old daemon fails at call time.
- Clients currently have no standard way to distinguish "feature unavailable on this daemon" from other user-facing errors.

## 2. Concrete recommendations

Priority order below is based on reducing silent data loss first, then improving compatibility signaling.

### P0: Add tolerant wire schemas for provider event enums

Use open-ended schemas for provider-controlled fields, not for Orka-controlled control-plane fields.

Recommended candidates in `packages/core/src/provider-events.ts`:

- `CanonicalItemTypeSchema`
- `CanonicalRequestTypeSchema`
- `RuntimeSessionStateSchema`
- `RuntimeTurnStateSchema`
- `RuntimeItemStatusSchema`
- `RuntimeContentStreamKindSchema`

Recommended pattern:

```ts
const KnownCanonicalItemTypeSchema = z.enum([
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "error",
  "unknown",
]);

export const CanonicalItemTypeSchema = KnownCanonicalItemTypeSchema.or(z.string());
```

Do the same for the other provider-owned enums. Then add helper predicates for "known" values where internal code needs branching.

Do not do this for:

- `BackendKindSchema`
- `SessionStatusSchema`
- `PushChannelSchema`
- `ApprovalDecisionSchema`

Those are Orka-owned control-plane values and should remain closed unless there is explicit negotiation.

### P0: Stop dropping unknown provider event types on ingestion

`mapProviderEvent()` currently returns `null` for unknown provider event types. That is the highest-risk behavior because it causes silent data loss.

Recommended change in design, even if implemented later:

- Introduce an `orchestration.unknown` event or a generic `"runtime.warning"` mapping that preserves:
  - provider event `type`
  - raw payload
  - provider name
  - timestamp
- Persist and broadcast that event instead of returning `null`.

This keeps the timeline complete and gives the dashboard something inspectable even before it has first-class UI for the new event.

### P1: Add event envelope versioning

Add a `v` field to serialized event envelopes.

Recommendation:

- Treat all current persisted and pushed events as implicit `v = 1`.
- Start writing `v: 1` on both provider runtime events and orchestration events.
- Readers should interpret missing `v` as `1`.
- For future incompatible event-shape changes:
  - add `v: 2`
  - keep a small migration function at the read boundary
  - normalize into one internal representation before reducers or projections run

Important detail:

- Adding optional `v` inside the JSON payload is safe now and does not require a SQLite schema migration.
- Adding a separate indexed SQL column for `v` would require a migration, but it is not necessary to get the compatibility benefit.

### P1: Add RPC capability/version negotiation

Method additions are fine; method usage is what breaks. Add explicit compatibility signaling so clients can check before calling.

Recommendation:

- Add a stable server-info surface with:
  - `rpcVersion`
  - `minSupportedRpcVersion`
  - `capabilities`
  - optionally `eventProtocolVersion`
- Expose the same data in:
  - an RPC method such as `getServerInfo`
  - `server.welcome` for dashboard sessions

Client behavior:

- Prefer capability checks before using optional methods.
- If a feature-specific RPC still returns `-32601`, treat it as "unsupported by this daemon" and degrade cleanly.
- Reserve generic error treatment for everything else.

### P1: Add dashboard version-mismatch invalidation

The dashboard already receives `serverVersion` in `server.welcome`, but it does not use it for compatibility decisions.

Recommendation:

- Embed a dashboard build version and protocol compatibility range in the frontend bundle.
- On connect and reconnect, compare it to the server’s advertised version/protocol.
- If the versions are outside the compatible range:
  - clear timeline cache and transport-side latest-push state
  - refetch session lists and timelines
  - show a reload banner
  - for a hard major mismatch, force a full reload instead of continuing with stale reducers

This is especially important because current push-gap handling only reports gaps; it does not repair local state.

### P2: Adopt a backward-compatible field-addition policy

Within the same event-envelope version:

- New fields must be optional.
- Consumers must ignore unknown fields.
- Existing field meaning must not change.
- Existing fields must not be removed or renamed.
- New enum/string values are allowed only on open-ended wire schemas.
- If a change is not backward-compatible, bump `v`.

For RPC:

- New optional params are fine.
- New response fields are fine.
- Method renames and removals are not fine without a compatibility window.

### P2: Validate at boundaries, trust internally

Current design mostly trusts event payloads at boundaries and then uses narrow internal unions. The safer split is the opposite:

- Boundary validation:
  - provider raw JSON / raw-log replay
  - SQLite event payload read
  - RPC request and response payloads
  - push envelope payloads
- Internal trust:
  - after normalization into a stable internal event representation
  - reducers and projections can use exhaustive switches again

Recommended shape:

- `Wire*Schema`: tolerant, open-ended, version-aware
- `Internal*` types: normalized, explicit, exhaustively handled

## 3. Migration plan

### 3.1 Safe to do now without breaking existing data

- Start writing `v: 1` on new event payloads while treating missing `v` as legacy `v: 1`.
- Add tolerant wire schemas for provider-controlled enum fields.
- Add unknown-event preservation instead of dropping new provider events.
- Add client handling for RPC `-32601` as an unsupported-feature path.
- Use `server.welcome` plus a compatibility range to invalidate dashboard state on mismatch.
- Add logging/telemetry when the dashboard or daemon sees an unknown event type or unknown enum value.

None of those require rewriting existing event rows.

### 3.2 What needs a migration step

- Any breaking change to persisted event shape where old JSON can no longer be normalized on read.
- Any desire to index/query event version separately in SQLite.
- Any rename/removal of RPC methods that existing clients call.
- Any control-plane enum expansion that changes `PushChannelSchema`, `SessionStatusSchema`, or `BackendKindSchema` without compatibility handling.

If a future event change cannot be normalized by a reader migration function, use one of:

1. SQLite backfill migration for persisted orchestration events.
2. Raw-log replay backfill to regenerate orchestration events from provider source data.

### 3.3 Why raw JSONL logs matter

Raw provider logs are the strongest escape hatch for protocol evolution.

Current support already exists:

- sessions record `rawLogFile`
- adapters support `replayRawLog()`
- `backfillSession()` deletes stored orchestration events and rebuilds them from the raw provider log

That gives Orka a recovery path when:

- event mapping logic changes
- old mappings dropped useful data
- a new event envelope version needs regeneration
- a bug produced bad orchestration events in SQLite

In practice, that means:

- SQLite orchestration events can stay as a cache/projection layer
- raw JSONL logs remain the source material for rehydration and migration

## Summary

The protocol’s biggest current weakness is silent loss of unknown provider event types at ingestion. The second is the lack of versioning and boundary validation for persisted orchestration events. The safest near-term path is:

1. Make provider-facing enums open-ended.
2. Add `v` to event envelopes.
3. Preserve unknown events instead of dropping them.
4. Add explicit RPC/server capability negotiation.
5. Invalidate dashboard state when client/server protocol versions diverge.

That keeps today’s data readable, improves old-client/new-daemon behavior, and leaves room for event evolution without forcing immediate SQLite rewrites.
