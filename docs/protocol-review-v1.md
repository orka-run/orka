# Orka Protocol v1 Review

## Scope and Bottom Line

This review compares the protocol draft in `docs/protocol-spec.md` and the target architecture in `docs/architecture-target.md` against the current implementation in `packages/core`, `packages/daemon`, and `packages/relay`.

Bottom line: the protocol direction is sound, but the current implementation is only partially aligned with the spec. The biggest issues are transport-level drift between the documented RPC shapes and the actual handler contract, incomplete relay support for push and encryption, and a few forward-compatibility mechanisms that exist in name but are brittle in practice.

## A. Correctness Audit

### High-severity findings

1. `GET /health` does not match the documented wire contract.

The spec requires both `protocolVersion` and `capabilities`, and the example includes `serverVersion` as part of the health payload (`docs/protocol-spec.md:34-55`). The daemon currently returns `status`, `protocolVersion`, `capabilities`, and optionally `publicKey`, but omits `serverVersion` entirely (`packages/daemon/src/server.ts:77-88`).

2. Capability advertisement can claim encryption support when the connection is not actually encrypted.

`buildCapabilities()` reports encryption as enabled whenever a node keypair exists on disk (`packages/daemon/src/server.ts:42-50`). The server only derives per-connection encryption keys when `opts.encrypt` is set and a keypair is loaded into memory (`packages/daemon/src/server.ts:62-67`, `packages/daemon/src/server.ts:125-133`). That means a daemon started without `--encrypt` can still advertise `"x25519-aes256gcm"` if an old keypair is present, while providing neither `publicKey` nor request decryption.

3. The current E2E key derivation is not per-session and does not deliver the security properties claimed in the comments/spec.

The spec defines a deterministic salt based on the two public keys and frames the result as a session key (`docs/protocol-spec.md:414-420`). The implementation derives the key from long-lived client and server keys plus a deterministic salt based only on the two public keys (`packages/core/src/crypto.ts:76-90`, `packages/daemon/src/server.ts:128-131`, `packages/daemon/src/remote-client.ts:64-70`). That produces the same symmetric key for every connection between the same peers. The comments also claim “perfect forward secrecy” and “ephemeral session keys,” which the current design does not provide (`packages/core/src/crypto.ts:8-21`).

4. E2E encryption does not work through the relay.

The architecture and spec both assume relay transparency for encrypted payloads (`docs/architecture-target.md:85-99`, `docs/protocol-spec.md:459-470`). In practice, the client sends its `pubkey` query parameter only to the relay URL (`packages/daemon/src/remote-client.ts:73-78`); the relay ignores it and upgrades the client connection without forwarding key material to the node (`packages/relay/src/index.ts:198-223`). The node-side relay connection then handles forwarded requests without any `encKey` at all (`packages/daemon/src/server.ts:237-256`). An encrypted request sent through the relay therefore reaches the daemon as opaque `_enc` data with no key to decrypt it.

5. Push is not implemented through the relay, despite the spec and target architecture depending on it.

The protocol says clients subscribe with control messages, receive `server.welcome` on connect, and can receive pushed orchestration events (`docs/protocol-spec.md:195-241`). The target architecture says dashboard clients may connect via relay (`docs/architecture-target.md:53-58`, `docs/architecture-target.md:132-139`). The relay currently accepts only JSON-RPC-like request envelopes from clients (`packages/relay/src/index.ts:340-378`) and routes only node responses that carry an `id` (`packages/relay/src/index.ts:488-523`). Push control messages have no `jsonrpc`, and push envelopes have no `id`, so subscribe, `server.welcome`, and ordinary push delivery do not traverse the relay at all.

6. The relay method allowlist contradicts the spec and blocks many documented methods.

The spec explicitly says old relays should pass new methods through unchanged and treat allowlist updates as deployment concerns, not wire-protocol coupling (`docs/protocol-spec.md:472-479`, `docs/protocol-spec.md:500-507`). The relay instead hard-codes a short allowlist (`packages/relay/src/index.ts:34-39`) that excludes many methods already present in the protocol and daemon handler, including `getSessionTimeline`, `getChatMessages`, `getUsage`, `getPendingApprovals`, `resolveApproval`, `reportEventGap`, `backfillSession`, `getMetrics`, `queryTraces`, and every terminal RPC (`packages/daemon/src/rpc-handler.ts:132-243`). Because the relay returns `-32601` for blocked methods (`packages/relay/src/index.ts:387-395`), the client sees the same error shape it would get from an older daemon (`packages/daemon/src/remote-client.ts:146-153`, `packages/core/src/errors.ts:8-16`), which masks the real compatibility boundary.

7. The documented RPC shapes do not match the actual handler contract.

Examples:

- Spec: `getSession({ sessionId })`; implementation: `getSession({ id })` (`docs/protocol-spec.md:123`, `packages/daemon/src/rpc-handler.ts:132-133`, `packages/daemon/src/remote-client.ts:216-218`).
- Spec: `getChildSessions({ parentId })`; implementation: `getChildSessions({ sessionId })` (`docs/protocol-spec.md:125`, `packages/daemon/src/rpc-handler.ts:136-137`, `packages/daemon/src/remote-client.ts:224-226`).
- Spec: `getTask({ taskId })`; implementation: `getTask({ id })` (`docs/protocol-spec.md:126`, `packages/daemon/src/rpc-handler.ts:138-139`, `packages/daemon/src/remote-client.ts:228-230`).
- Spec: `deleteSessions({ sessionIds })`; implementation: `deleteSessions({ ids })` (`docs/protocol-spec.md:148`, `packages/daemon/src/rpc-handler.ts:166-173`, `packages/daemon/src/remote-client.ts:287-289`).
- Spec: terminal RPCs use `terminalId`; implementation uses `termId`, and `terminalOpen` nests size in `opts` instead of top-level `cols`/`rows` (`docs/protocol-spec.md:164-168`, `packages/daemon/src/rpc-handler.ts:209-221`, `packages/daemon/src/remote-client.ts:339-357`).
- Spec: `getLogContent({ sessionId, offset?, limit? }) -> LogContent`; implementation exposes `getLogContent(sessionId) -> string | null` in the service interface and remote client (`docs/protocol-spec.md:138`, `packages/core/src/service.ts:105-112`, `packages/daemon/src/remote-client.ts:267-269`).

This is more than cosmetic drift: a client written to the spec will not interoperate with the daemon.

8. Known malformed orchestration events can bypass variant validation and still be treated as valid known events.

`WireOrchestrationEventSchema` validates known event variants, but on validation failure it falls back to the base envelope instead of rejecting or wrapping the event (`packages/core/src/orchestration.ts:337-345`). `normalizeEvent()` then treats any recognized `type` as a strict `OrchestrationEvent` regardless of whether required fields were present (`packages/core/src/orchestration.ts:371-382`). A malformed `turn.completed` without `turnId`, for example, can survive parsing as a supposedly valid known event rather than becoming `event.passthrough` or being rejected. That violates the documented “boundary validation” intent and can corrupt downstream projections.

9. Unknown provider events are not preserved with enough information to support future replay/debugging.

The spec says `event.passthrough` preserves the full payload of unknown provider events for future processing (`docs/protocol-spec.md:329-339`). The ingestion default case stores only `payload`, plus `turnId` and `provider` when present (`packages/daemon/src/orchestration/ingestion.ts:177-191`). It drops the provider event envelope fields such as `eventId`, `threadId`, `itemId`, `requestId`, and `v` that exist on provider-runtime events (`packages/core/src/provider-events.ts:83-92`, `packages/core/src/provider-events.ts:166-223`). That is partial preservation, not full preservation.

10. The wire event pushed to clients does not include `eventId`, but the target architecture requires deduplication by `eventId`.

The target aggregator design says replayed/reconnected events must be deduplicated idempotently by `eventId` (`docs/architecture-target.md:112-120`). `OrchestrationEvent` on the wire omits `eventId`; only `PersistedOrchestrationEvent` carries it for DB persistence (`packages/core/src/orchestration.ts:133-136`). The orchestration engine persists `eventId` but broadcasts the stripped-down event to clients (`packages/daemon/src/orchestration/engine.ts:49-53`, `packages/daemon/src/orchestration/engine.ts:68`). That makes the future aggregator contract impossible to satisfy without revising the wire format.

### Medium-severity findings

11. Unknown push channel subscriptions are rejected instead of being silently ignored.

The spec requires servers to ignore unknown channel names so new clients can subscribe against older servers (`docs/protocol-spec.md:197-209`, `docs/protocol-spec.md:530`). The daemon parses subscribe/unsubscribe control messages with a closed `PushChannelSchema` enum (`packages/core/src/push-protocol.ts:7-14`, `packages/core/src/push-protocol.ts:86-103`), so a request containing an unknown channel fails control-message parsing in `server.ts` (`packages/daemon/src/server.ts:152-159`). It is then treated as an RPC request, which will fail instead of being ignored (`packages/daemon/src/server.ts:176-178`, `packages/daemon/src/rpc-handler.ts:244-248`).

12. `orchestration.sessionUpdated` is sometimes emitted with the wrong payload shape.

The channel contract requires both `sessionId` and `status` (`packages/core/src/push-protocol.ts:70-73`). `unarchiveSession` currently broadcasts `{ sessionId }` without `status` (`packages/daemon/src/rpc-handler.ts:187-190`), violating the channel schema and creating an avoidable client-side edge case.

13. The relay breaks JSON-RPC correlation when a node disconnects.

On node disconnect, the relay sends an error back to waiting clients with `id: pr.method` instead of the original request ID (`packages/relay/src/index.ts:274-283`). `PendingRequest` does not store the original request ID at all (`packages/relay/src/state.ts:26-33`). That makes the response impossible to correlate correctly and violates JSON-RPC response semantics.

14. The relay only accepts string request IDs even though the protocol allows string or number.

The spec and core RPC types allow `id: string | number` (`docs/protocol-spec.md:63-71`, `packages/core/src/rpc.ts:3-11`). The relay rejects any request whose `id` is not a string (`packages/relay/src/index.ts:359-367`). The daemon itself is permissive here, so the relay is narrower than the protocol.

15. Boundary validation for RPC envelopes and params is very weak.

The spec defines `INVALID_REQUEST` and `INVALID_PARAMS` and says missing required envelope fields should map to `-32600` / `-32602` (`docs/protocol-spec.md:90-103`). `handleRpcRequest()` only checks whether JSON parsing succeeded (`packages/daemon/src/rpc-handler.ts:22-32`). It does not validate `jsonrpc`, `method`, or request-specific param shapes before dispatching (`packages/daemon/src/rpc-handler.ts:71-90`, `packages/daemon/src/rpc-handler.ts:101-249`). Invalid requests can therefore surface as misleading `METHOD_NOT_FOUND` or internal errors instead of disciplined protocol errors.

16. The `v` field exists, but there is no actual migration mechanism.

The spec requires per-type migration when old event versions are read (`docs/protocol-spec.md:261-266`, `docs/protocol-spec.md:401-403`; `docs/architecture-target.md:201-210`). The implementation only fills in `v = 1` when absent (`packages/core/src/orchestration.ts:371-375`) and does not contain a migration registry or type-specific normalization by version.

17. Capability negotiation is stricter than the spec in places where it should be open-ended.

The spec models `capabilities.adapters` as `string[]` (`docs/protocol-spec.md:42-49`). The implementation validates it as `z.array(BackendKindSchema)`, which is a closed enum of `claude-code | codex | shell` (`packages/core/src/push-protocol.ts:50-57`, `packages/core/src/types.ts:18-19`). A newer daemon advertising a new adapter would fail older client parsing rather than degrade gracefully.

18. Protocol-version parsing is exact-match only at the schema layer.

The welcome schema uses `z.literal(PROTOCOL_VERSION)` (`packages/core/src/push-protocol.ts:61-66`). That means schema-based consumers cannot parse a future `protocolVersion` value and then decide how to degrade; they must bypass the schema or fail early. This is workable for now, but it is not a strong compatibility boundary.

### Lower-severity observations

19. `reportEventGap` exists mostly as telemetry, not as recovery.

The spec says the server MAY resend missed events and the architecture target says the server responds with backfill for gaps (`docs/protocol-spec.md:234-241`, `docs/architecture-target.md:262-267`). The service surface exposes `reportEventGap()` (`packages/core/src/service.ts:127-133`), the RPC handler forwards it (`packages/daemon/src/rpc-handler.ts:196-208`), and `LocalClient` currently implements it as a no-op (`packages/daemon/src/local-client.ts:439`). Today this is observability, not gap repair.

20. `runtime.error.terminal` is modeled in orchestration events but effectively not produced by provider-event ingestion.

`OrchestrationEvent` allows `terminal?: boolean` on `runtime.error` (`packages/core/src/orchestration.ts:114-120`), and the engine uses that flag to force a failed projection (`packages/daemon/src/orchestration/engine.ts:237-242`). But `RuntimeErrorPayload` on provider events does not include `terminal`, and the ingestion mapper never sets it (`packages/core/src/provider-events.ts:161-164`, `packages/daemon/src/orchestration/ingestion.ts:156-166`). The projection path therefore depends on a field that provider-runtime ingestion cannot currently supply.

## B. Forward Compatibility Assessment

| Mechanism | Score | What works | Remaining brittleness |
|---|---:|---|---|
| Wire enums | 4/5 | Event-level enums are mostly open-ended strings on the wire: item types, stream kinds, session state, turn state, and item status all accept unknown string values (`packages/core/src/provider-events.ts:10-80`, `packages/core/src/orchestration.ts:193-324`). | This openness is inconsistent. Push channels are closed (`packages/core/src/push-protocol.ts:7-14`), capability adapters are closed (`packages/core/src/push-protocol.ts:50-57`, `packages/core/src/types.ts:18-19`), and some values are later cast into narrower internal unions without revalidation (`packages/core/src/orchestration.ts:379-382`). |
| `event.passthrough` | 2/5 | Unknown orchestration event types are wrapped instead of rejected (`packages/core/src/orchestration.ts:384-394`), and unknown provider event types map to `event.passthrough` (`packages/daemon/src/orchestration/ingestion.ts:177-191`). | It is not preserving enough information for replay/debugging, and malformed known events are not converted to passthrough at all (`packages/core/src/orchestration.ts:337-345`). That sharply limits its usefulness as a long-term escape hatch. |
| `v` field | 2/5 | New provider-runtime events and ingested orchestration events consistently write `v: 1`, and missing `v` is normalized to `1` on read (`packages/core/src/provider-events.ts:242-253`, `packages/daemon/src/orchestration/ingestion.ts:8-176`, `packages/core/src/orchestration.ts:371-375`). | There is no version-specific migration logic yet, so the mechanism is only a marker, not a real compatibility system (`packages/core/src/orchestration.ts:371-394`). |
| Capability negotiation | 2/5 | The daemon advertises `protocolVersion` and `capabilities` on both `/health` and `server.welcome` (`packages/daemon/src/server.ts:77-88`, `packages/daemon/src/server.ts:183-191`), and the client has an explicit `MethodNotFoundError` type for optional RPC downgrade (`packages/core/src/errors.ts:8-37`, `packages/daemon/src/remote-client.ts:146-153`). | Encryption capability can lie, adapter lists are closed, welcome version parsing is exact-match only, and the relay can manufacture `-32601` responses that look like daemon capability gaps (`packages/daemon/src/server.ts:42-50`, `packages/relay/src/index.ts:34-39`, `packages/relay/src/index.ts:387-395`). |
| Boundary validation | 1/5 | There is at least a base envelope validator for orchestration events and a push control schema (`packages/core/src/orchestration.ts:174-179`, `packages/core/src/push-protocol.ts:86-103`). | RPC requests are barely validated, known malformed events can slip through as valid, and unknown subscribe channels are rejected instead of ignored (`packages/daemon/src/rpc-handler.ts:22-32`, `packages/core/src/orchestration.ts:337-345`, `packages/daemon/src/server.ts:152-159`). |

Overall assessment: the protocol has the right compatibility primitives, but only wire enums are close to production-grade. The rest still need stricter implementation discipline before they can absorb version skew confidently.

## C. gRPC Migration Feasibility

### Overall judgment

Migration to gRPC is feasible, but not as a drop-in replacement for the current transport. The current design is transport-neutral at the semantic level in some places, but several v1 choices are tightly coupled to WebSocket + JSON envelopes and would need cleanup first.

### What maps cleanly

- Unary JSON-RPC methods map cleanly to unary gRPC methods. The current `OrkaService` surface is already a transport-neutral method list in spirit (`packages/core/src/service.ts:89-150`).
- `server.welcome` and push subscriptions can map to server-streaming RPCs. For example, `Subscribe(SubscriptionRequest) returns (stream PushEnvelope)` is a natural replacement for the current subscribe/unsubscribe side channel (`docs/protocol-spec.md:195-241`, `docs/architecture-target.md:132-139`).
- The existing capability object and protocol version can move into either a dedicated `GetHealth` unary RPC or initial stream metadata/message (`docs/protocol-spec.md:34-55`, `packages/daemon/src/server.ts:77-88`, `packages/daemon/src/server.ts:183-191`).

### What is problematic

1. Relay transparency is much harder with native gRPC than with JSON-RPC-over-WS.

The relay today routes using JSON envelope fields like `id`, `method`, and `node` (`docs/protocol-spec.md:461-470`, `packages/relay/src/index.ts:351-371`). In gRPC, the method is encoded in the HTTP/2 path, there is no JSON-RPC `id`, and the routing hint would need to move into headers/metadata. A transport-agnostic relay is still possible, but it becomes “metadata-aware opaque proxy,” not “JSON envelope router.”

2. The current E2E model does not cleanly survive a gRPC migration.

Today’s scheme assumes plaintext routing metadata plus an application-encrypted `params` or `result` field (`docs/protocol-spec.md:422-457`, `packages/core/src/crypto.ts:141-194`). gRPC wants typed protobuf messages. To keep relay-visible routing but relay-blind payloads, you would likely need a message shape like:

- plaintext headers/metadata for auth, routing, trace context, and node hint
- protobuf message containing either normal typed fields or an opaque encrypted `bytes payload`

That works, but it gives up a lot of the ergonomic value of protobuf for the encrypted parts. If the project is willing to rely on TLS plus relay trust boundaries instead, the migration is much easier, but that is a different security model than the current spec.

3. Open-ended event types and passthrough do not map well to protobuf enums.

The current protocol intentionally keeps wire enums open-ended strings (`docs/protocol-spec.md:340-404`, `packages/core/src/provider-events.ts:10-80`). Protobuf enums are a worse fit for that requirement. A protobuf schema can still work if the wire keeps `string type`, `string item_type`, and `google.protobuf.Struct` / `bytes raw_payload` for passthrough, but that means using protobuf more like a typed envelope than a closed algebraic schema.

4. gRPC-web is sufficient for the dashboard only if the subscription model stays server-streaming.

Dashboard needs unary RPC plus server push (`docs/architecture-target.md:132-139`). gRPC-web supports unary and server streaming in practice, but not general bidi streaming in browsers. That is acceptable if subscriptions become “open one server stream per client/session/channel-set.” It is a poor fit if the design keeps the current model of sending ad hoc subscribe/unsubscribe control messages on the same full-duplex socket.

### Could protobuf replace the current zod schemas?

Yes, for the transport contract, but not completely and not immediately.

- Protobuf is a good fit for the RPC method surface and the stable parts of push envelopes.
- Zod is still useful at the JS boundary for defensive validation of untyped inputs, config, DB reads, and backward-compatibility migrations.
- For event payloads, protobuf should avoid closed enums where the protocol wants open-ended strings. If protobuf is adopted, prefer string-valued wire fields plus a `oneof` for known event payloads and a passthrough fallback carrying `type`, `v`, and raw data.

### Impact on the relay

The relay can remain transport-agnostic only if the project first defines a transport-independent routing contract:

- auth metadata
- node-selection hint
- request correlation identifier
- tracing metadata
- opaque payload

Under JSON-RPC/WS that contract lives in the JSON envelope. Under gRPC it would need to move to headers plus protobuf message fields. The current relay implementation is not yet abstract enough for that; it is explicitly JSON-RPC-aware (`packages/relay/src/index.ts:351-371`, `packages/relay/src/index.ts:488-523`).

### Recommended migration path

1. Stabilize the semantic protocol first.

Fix the RPC shape drift, add wire `eventId`, make capability advertisement truthful, and define clear validation/error rules. Without that, a gRPC port will just encode today’s inconsistencies into a harder-to-change transport.

2. Define a transport-neutral IDL.

Create a single canonical method/event schema package that both WS/JSON-RPC and any future gRPC transport derive from. For JS/TS, zod can remain the executable validator; protobuf can become an additional generated transport layer rather than the source of truth on day one.

3. Introduce a second transport in parallel.

Keep WS/JSON-RPC for CLI compatibility. Add a gRPC or Connect/Connect-Web adapter for new clients. Do not attempt a flag day.

4. Redesign E2E before or during the transport split.

If relay-blind application encryption is still a requirement, move to an explicit connection handshake with ephemeral key exchange and an opaque encrypted message body that does not depend on WebSocket query parameters.

5. Make the relay route on transport-neutral metadata.

Once routing/auth/correlation are expressed independently of JSON-RPC, the relay can proxy WS JSON-RPC and gRPC side by side.

## D. Top 5 Recommendations for Protocol v2

1. Publish a single canonical protocol contract and generate the transport adapters from it.

The spec, `OrkaService`, daemon handler, remote client, and relay allowlist currently drift independently (`docs/protocol-spec.md:105-179`, `packages/core/src/service.ts:89-150`, `packages/daemon/src/rpc-handler.ts:101-249`, `packages/relay/src/index.ts:34-39`). v2 should have one authoritative method table with request/response schemas and compatibility annotations.

2. Put `eventId` on every wire event and make passthrough preserve the full source envelope.

This is required for the future aggregator design and for safe replay/deduplication (`docs/architecture-target.md:112-120`, `packages/core/src/orchestration.ts:133-136`, `packages/daemon/src/orchestration/engine.ts:49-53`). `event.passthrough` should also retain the original provider event envelope, not just `payload`.

3. Make the transport boundary truly forward-compatible.

Unknown push channels should be ignored, capability adapter names should be open strings, known malformed events should be rejected or downgraded to passthrough instead of being cast as valid, and every RPC should validate envelope + params before dispatch (`docs/protocol-spec.md:207-209`, `docs/protocol-spec.md:386-404`, `packages/core/src/push-protocol.ts:7-14`, `packages/core/src/orchestration.ts:337-345`, `packages/daemon/src/rpc-handler.ts:22-32`).

4. Redesign the encryption handshake to be truthful, per-connection, and relay-compatible.

At minimum, v2 needs an explicit handshake that gives the node the client’s key material when traffic flows through a relay, and the derived session key must vary per connection instead of per identity pair (`packages/core/src/crypto.ts:76-90`, `packages/daemon/src/server.ts:125-133`, `packages/daemon/src/server.ts:237-256`, `packages/daemon/src/remote-client.ts:64-78`).

5. Separate the semantic protocol from the transport so gRPC becomes an option, not a rewrite.

Define the routing metadata, auth metadata, correlation ID, push subscription model, and event schema independently of WebSocket + JSON-RPC. Then implement WS/JSON-RPC as one adapter and gRPC/Connect as another. That keeps the relay transport-agnostic and avoids baking transport quirks into the domain model (`docs/architecture-target.md:83-99`, `docs/architecture-target.md:174-232`, `docs/protocol-spec.md:459-479`).

## Final Assessment

Protocol v1 has the right high-level shape: JSON-RPC for command/query traffic, push channels for live state, open-ended wire enums, and explicit capability/version metadata. The implementation is not there yet. The main gaps are not cosmetic; they affect interoperability, correctness under version skew, and whether the relay can actually serve as a transparent transport boundary.

If v1 is treated as an internal draft and the current code is still allowed to evolve, the protocol can be stabilized without a fundamental redesign. If v1 is expected to become a durable external contract, the mismatches above should be resolved before treating it as frozen.
