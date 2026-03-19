# Type Safety Audit

Scope: `packages/core`, `packages/client`, `packages/daemon`, `packages/dashboard`

Focus: gaps that can cause silent wrong behavior similar to the `"stopSession"` vs `"stop"` bug. I did not list test-only code. I also skipped low-value style-only findings unless they materially weaken the RPC contract.

## Risk legend

- `P0` — silent wrong behavior or wire-contract drift already present
- `P1` — likely bug source or runtime contract break
- `P2` — weaker boundary / maintenance smell

## Findings

### P0

1. `packages/dashboard/src/lib/rpcClient.ts:50`
   Gap: `listSessions` sends `filters` directly via `rpc("listSessions", filters, ...)`, but the daemon expects `params.filters` in `packages/daemon/src/rpc-handler.ts:117`.
   Why it matters: any non-empty filter object is silently ignored because `params.filters` is `undefined` on the server.
   Suggested fix: derive params from a shared RPC method map and make the wire shape for `listSessions` be `{ filters?: SessionFilters }`.

2. `packages/dashboard/src/lib/rpcClient.ts:142`
   Gap: `terminalOpen` sends `{ sessionId, ...opts }`, but the daemon reads `params.opts` in `packages/daemon/src/rpc-handler.ts:219`.
   Why it matters: `cols`/`rows` are silently dropped, so terminal sizing requests compile but do not take effect.
   Suggested fix: make the params type for `"terminalOpen"` be `{ sessionId: string; opts?: { cols?: number; rows?: number } }` and have the wrapper send exactly that.

3. `packages/dashboard/src/lib/rpcClient.ts:160`
   Gap: `updateWorkspace` sends `{ id, ...opts }`, but the daemon reads `params.opts ?? {}` in `packages/daemon/src/rpc-handler.ts:252`.
   Why it matters: workspace updates can silently no-op because the server never sees an `opts` object.
   Suggested fix: make the params type for `"updateWorkspace"` be `{ id: string; opts: Partial<...> }` and enforce it at compile time.

4. `packages/daemon/src/aggregating-client.ts:198`
   Gap: `callLocal()` falls through to `svc[method](params)` for unhandled methods. `closeSession` is routed through `routeBySession()` at `packages/daemon/src/aggregating-client.ts:399` but has no explicit `callLocal` case.
   Why it matters: local `closeSession` receives `{ sessionId }` instead of `string`, so the local path can fail or look up the wrong session at runtime.
   Suggested fix: replace string-dispatch with a typed local routing table keyed by RPC method, and add an explicit `closeSession` entry immediately.

5. `packages/dashboard/src/App.tsx:566`
   Gap: the dashboard bypasses the client wrapper and calls `transport.request("stop", ...)` directly.
   Why it matters: this recreates the exact class of bug that produced `"stopSession"`; a typo here compiles because `request()` takes `method: string`.
   Suggested fix: route all dashboard RPC calls through a typed client interface and restrict raw `transport.request()` to transport-internal code.

6. `packages/dashboard/src/lib/rpcClient.ts:34`
   Gap: the wrapper root is `rpc<T>(method: string, params?: unknown, ...)`, so callers pick both the method name and result type independently.
   Why it matters: this is the root cause for the three mismatched wire shapes above and for unsupported methods compiling at all.
   Suggested fix: define a shared `RpcMethodMap` in `@orka/core` with method name, params schema, and result type; implement `rpc<M extends keyof RpcMethodMap>(method: M, params: RpcParams[M])`.

7. `packages/client/src/ws-transport.ts:238`
   Gap: `WsTransport.request<T>(method: string, params?: unknown, ...)` accepts arbitrary method names and caller-chosen response types.
   Why it matters: any direct caller can send a misspelled method or claim the wrong response type and still compile.
   Suggested fix: make `WsTransport.request` generic over a shared RPC method map instead of `string` + unconstrained `T`.

8. `packages/client/src/orka-client.ts:200`
   Gap: the CLI/client transport path uses `call(method: string, params?: any): Promise<any>`.
   Why it matters: `OrkaClient` wrappers look typed externally, but the wire contract underneath is unchecked, so method/param/result drift is invisible to TypeScript.
   Suggested fix: make `call` generic over the shared RPC method map and remove `any` from pending resolution and request construction.

9. `packages/daemon/src/rpc-handler.ts:87`
   Gap: server dispatch is `dispatch(..., method: string, params: any)` with a string `switch` and unchecked property access like `params.sessionId`, `params.id`, and `params.opts`.
   Why it matters: method names, param shapes, and handler signatures can drift independently; the compiler does not connect the dispatch table to `OrkaService`.
   Suggested fix: replace the `switch` with a typed handler map keyed by shared RPC method names, and validate `params` with zod per method before dispatch.

10. `packages/core/src/rpc.ts:6`
    Gap: the core RPC envelope still exposes `method: string`, `params?: any`, `result?: any`, and `error.data?: any`.
    Why it matters: every layer above inherits an untyped wire contract, so TypeScript cannot prove method existence or param/result compatibility.
    Suggested fix: promote the RPC contract into `@orka/core` as a typed method map plus request/response helpers derived from that map.

### P1

11. `packages/dashboard/src/lib/rpcClient.ts:170`
    Gap: the dashboard defines `retrySession` as an RPC method even though it is not in `OrkaService` and there is no daemon handler.
    Why it matters: `packages/dashboard/src/components/SessionView.tsx:134` calls it, so the dashboard can compile while shipping a guaranteed runtime method-not-found path.
    Suggested fix: make the dashboard client implement an explicit shared interface. If retry is intended, add it to the core contract and server dispatch; otherwise remove the method.

12. `packages/daemon/src/remote-nodes.ts:35`
    Gap: cross-node routing is `request<T>(nodeId: string, method: string, params?: unknown)`.
    Why it matters: remote RPC calls have the same typo/shape-drift problem as local RPC, just across another boundary.
    Suggested fix: use the same shared RPC method map for `RemoteNodeManager.request`.

13. `packages/daemon/src/local-client.ts:631`
    Gap: backfill replays raw provider logs via `JSON.parse(l) as RawProviderLine` with no schema validation.
    Why it matters: corrupt or version-skewed raw logs can be re-ingested as trusted provider events and produce wrong reconstructed timelines.
    Suggested fix: add a `RawProviderLine` zod schema at the file boundary and reject invalid rows before replay.

14. `packages/daemon/src/result-parser.ts:72`
    Gap: both result parsers deserialize provider JSON into `let parsed: any` and then read nested fields without validation.
    Why it matters: provider log format changes can silently skew result text, token counts, and error classification instead of failing loudly.
    Suggested fix: parse each recognized log variant through zod schemas and branch on validated discriminants.

15. `packages/daemon/src/db.ts:385`
    Gap: `getSessionEnv()` returns `JSON.parse(row.env_json) as Record<string, string>` with no validation.
    Why it matters: malformed DB state can feed invalid env data back into process execution paths.
    Suggested fix: validate env JSON with `z.record(z.string())` before returning it.

16. `packages/daemon/src/db.ts:918`
    Gap: workspace `settings`, `metadata`, and session `allowed_tools` are parsed with `JSON.parse(... ) as ...` in `buildWorkspaceInfo()` and `rowToSession()`.
    Why it matters: stale or corrupt DB rows bypass the type system and can change behavior long after the bad data was written.
    Suggested fix: add zod schemas for `WorkspaceSettings`, `WorkspaceMetadata`, and `allowedTools` at row-mapping time.

17. `packages/daemon/src/node-registry.ts:36`
    Gap: stored node files are deserialized straight into `StoredNode` with bare `JSON.parse`.
    Why it matters: malformed node metadata can poison relay URLs, Noise key material, or path lists without a typed boundary check.
    Suggested fix: validate node files with a `StoredNode` schema before returning them from the registry.

18. `packages/daemon/src/orchestration/engine.ts:192`
    Gap: the projection switch on `OrchestrationEvent["type"]` has no exhaustive `default`/`assertNever`.
    Why it matters: adding a new orchestration event can silently stop affecting session projection, leading to stale status/timing data.
    Suggested fix: end the switch with `default: assertNever(event)` or rewrite it to force exhaustiveness at compile time.

19. `packages/daemon/src/orchestration/consumer.ts:120`
    Gap: provider-event side effects use a partial `switch` with `default: return`.
    Why it matters: new `ProviderRuntimeEvent` variants will be silently ignored for log persistence, push behavior, and usage handling.
    Suggested fix: use an exhaustive switch for known events and handle intentionally-ignored cases explicitly.

20. `packages/dashboard/src/components/chat/eventsToEntries.ts:167`
    Gap: UI mode derivation and timeline rendering both use non-exhaustive switches with permissive defaults (`continue` / `break`).
    Why it matters: newly-added orchestration events can disappear from the UI silently even though the backend emits them correctly.
    Suggested fix: add an `assertNever` helper for known event unions and make passthrough handling explicit.

### P2

21. `packages/dashboard/src/lib/rpcClient.ts:33`
    Gap: `createRpcClient()` has no explicit shared return type; `RpcClient` is just `ReturnType<typeof createRpcClient>`.
    Why it matters: the client surface can drift from the daemon contract by inference alone, which is how unsupported methods and wrong param shapes accumulate.
    Suggested fix: declare `interface RpcClient` in terms of the shared RPC method map and annotate `createRpcClient(): RpcClient`.

22. `packages/daemon/src/orchestrator.ts:263`
    Gap: the orchestrator callback bundle uses `status: any`, `extra?: any`, `record: any`, and `decision: any`.
    Why it matters: these `any` escape hatches let invalid session status and approval shapes cross subsystem boundaries without compiler help.
    Suggested fix: replace the inline object with a named interface using `SessionStatus`, usage-record, and approval-decision types.

23. `packages/daemon/src/config.ts:349`
    Gap: config mutation falls back to `Record<string, any>` and `stringify(toml as any)`.
    Why it matters: this is less immediate than the RPC issues, but it weakens validation around a user-facing config boundary.
    Suggested fix: parse TOML into a typed config shape, mutate that, and serialize from the typed object instead of `any`.

## Highest-priority fixes

1. Define a shared `RpcMethodMap` in `@orka/core` with per-method param/result types and zod validators.
2. Make `WsTransport.request`, `OrkaClient.call`, dashboard `rpc()`, daemon `dispatch()`, and remote-node `request()` all consume that shared map.
3. Fix the already-broken dashboard wrappers for `listSessions`, `terminalOpen`, and `updateWorkspace`.
4. Replace `aggregating-client` string dispatch with a typed local routing table and add an explicit `closeSession` mapping.
5. Add zod validation for DB JSON columns, node registry files, and raw provider log replay input.
