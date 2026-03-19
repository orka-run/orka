# Protocol Audit: Design, Versioning, and Upgrade Safety

## Scope

This audit covers the current implementations behind:

- RPC: `packages/core/src/rpc.ts`, `packages/daemon/src/rpc-handler.ts`, `packages/client/src/orka-client.ts`
- Push: `packages/core/src/push-protocol.ts`, `packages/daemon/src/server.ts`, `packages/client/src/ws-transport.ts`, `packages/daemon/src/push-hub.ts`
- Orchestration events: `packages/core/src/orchestration.ts`, `packages/core/src/types.ts`, `packages/daemon/src/orchestration/engine.ts`, `packages/daemon/src/db.ts`
- Provider events: `packages/core/src/provider-events.ts`, `packages/daemon/src/orchestration/consumer.ts`, `packages/daemon/src/orchestration/ingestion.ts`
- Relay transport: `packages/core/src/transport-protocol.ts`, `packages/core/src/transport/noise-transport.ts`, `packages/relay/src/index.ts`, `packages/daemon/src/server.ts`
- Dashboard transport/auth path: `packages/dashboard/src/App.tsx`, `packages/dashboard/vite.config.ts`, `packages/client/src/auth.ts`, `packages/dashboard/src/components/ConnectionBanner.tsx`
- DB schema versioning: `packages/core/src/migrate.ts`, `packages/daemon/src/migrations/`

## Bottom line

Orka is partially future-proof today, but not fully safe under version skew.

What already degrades reasonably well:

- JSON-RPC envelopes are extensible enough for additive fields.
- Unknown RPC methods fail cleanly with `-32601`.
- Push payload consumers ignore unknown fields.
- Orchestration events are the most tolerant layer: they carry `v`, default missing `v` to `1`, preserve unknown fields, and wrap unknown or malformed event types as `event.passthrough`.
- SQLite migrations are forward-only but protected by backups and, with SQLite in Kysely, transactional DDL.

What is still brittle:

- There is no real client/server negotiation for RPC or push, only server-advertised `protocolVersion`.
- Relay transport has a hard `v: 1` handshake with no version range negotiation.
- Relay mode is not protocol-complete for push: encrypted `push_control` is dropped in the daemon relay path, and relay welcome delivery is malformed.
- New client features against old daemons still depend on ad hoc `MethodNotFoundError` handling, not a consistent capability contract.
- DB migrations are effectively one-way. Downgrade is manual restore from backup, not an automated rollback path.

If users install Orka today and you later ship additive changes only, direct CLI/dashboard to daemon upgrades are mostly survivable. If you ship breaking wire changes, relay transport changes, or rely on new push behavior, existing daemons/relays/dashboards can break.

## Protocol inventory

| Protocol | Transport | Versioned? | Forward-compatible today? | Notes |
| --- | --- | --- | --- | --- |
| RPC | JSON-RPC 2.0 over WS | No negotiated version; envelope has `jsonrpc: "2.0"` only | Partial | Additive fields are okay; new methods are not negotiated |
| Push | WS push envelopes + subscribe control messages | Server advertises `protocolVersion` in `server.welcome` | Partial | New channels can be ignored; no selected version or capability negotiation |
| Orchestration events | JSON event payloads in SQLite, RPC, and push | Yes, per-event `v` | Good | Best compatibility layer in the codebase |
| Provider events | Adapter-local runtime events | Yes, per-event `v` on created events | Partial | Unknown provider event types map to `event.passthrough`, but only after ingestion |
| Relay transport | Cleartext hello + Noise NK + encrypted `data` frames | Yes, `client_hello.v`, `server_hello.v`, `TransportPayload.v` | Weak | Hardcoded to `1`; no version range/capability negotiation |
| Dashboard <-> daemon HTTP/WS | Same-origin `/ws`, `/v1/traces`, optional relay token query param | Same push `protocolVersion` only | Partial | Direct daemon path assumes trusted same-origin/local access |
| DB schema | Kysely migrations on SQLite | Yes, ordered migration names | Partial | Safe forward migration, weak downgrade story |

## 1. RPC protocol

### Current behavior

- `RpcRequest` and `RpcResponse` are open-ended objects with stable JSON-RPC 2.0 core fields plus Orka-specific `traceparent` and `node`.
- The daemon validates only the top-level JSON-RPC envelope shape: valid JSON, `jsonrpc === "2.0"`, and `method` is a string.
- Unknown methods return `RPC_METHOD_NOT_FOUND` (`-32601`).
- Response parsing in `WsTransport` is permissive: extra fields are ignored.

### Compatibility assessment

- Unknown request fields: ignored.
- Unknown response fields: ignored.
- Unknown methods: fail cleanly, do not crash the daemon.
- Additive response fields: safe.
- Removing or renaming fields: unsafe because there is no negotiated schema/version boundary.
- New method on old daemon: fails at call time with `MethodNotFoundError`.

### Risks

- There is no client-advertised version range, so the daemon never selects a compatible RPC contract.
- Param validation is loose. That makes compatibility failures show up as generic server errors instead of disciplined `INVALID_PARAMS`.
- Optional-method downgrade exists, but only for a small set of callers. It is policy, not protocol.

### Recommendation

- Add a negotiated control-plane version range, not just `jsonrpc: "2.0"`.
- Add a `getServerInfo`/`getCapabilities` RPC that is guaranteed-stable and includes:
  - `rpcProtocol: { selected, minSupported, maxSupported }`
  - `pushProtocol: { selected, minSupported, maxSupported }`
  - feature flags/capabilities
- Treat `-32601` as fallback only for legacy daemons, not the primary compatibility mechanism.
- Add request-schema validation per method and return `-32602` for bad params.

## 2. Push protocol

### Current behavior

- Push envelopes are extensible: `{ type: "push", channel, sequence, data }`.
- `server.welcome` includes `serverVersion`, `protocolVersion`, and `capabilities`.
- `subscribe`/`unsubscribe` control messages accept any string channels, and the daemon filters to known channels. Unknown requested channels are ignored.
- The client accepts any string `channel` at runtime and only dispatches to handlers that exist.
- Gap detection exists, but recovery does not; the client reports gaps via `reportEventGap`, which is telemetry-only today.

### Compatibility assessment

- Unknown push channels from server: ignored if the client has no handler.
- New push channels: safe for old clients as long as they are additive.
- Unknown fields inside `data`: preserved unless a channel transform rejects them.
- Versioning: server-only advertisement. There is no negotiated selected version.
- Downgrade/upgrade UX: dashboard shows a mismatch banner; CLI generally does not.

### Risks

- `PROTOCOL_VERSION_RANGE` is currently `{ min: 1, max: 1 }`, so any version bump becomes a hard mismatch until every client is updated.
- `server.welcome` is the only compatibility signal. If that message is missed or malformed, the client cannot negotiate anything.
- Sequence numbers are useful for telemetry, not replay. Reconnect still requires a refetch.

### Recommendation

- Keep additive channel evolution rules:
  - old clients must ignore unknown channels
  - clients and servers must ignore unknown fields
- Add explicit version negotiation:
  - client sends supported range
  - server responds with selected push version and capabilities
- Add replay tokens or cursor-based resubscribe if push state is meant to survive reconnect without full refetch.

## 3. Orchestration events

### Current behavior

- Every event may carry `v`.
- `parseWireEvent()` tolerates missing `v` and normalizes it to `1`.
- Known event variants use `.passthrough()`, so unknown fields are preserved.
- Unknown event types are wrapped as `event.passthrough`.
- Known event types with invalid variant fields are also wrapped as `event.passthrough`.
- Events are stored as JSON in `orchestration_events.payload` and reparsed through `parseWireEvent()` on read.

### Compatibility assessment

- Additive fields: safe.
- Unknown event types: safe; they survive as passthrough.
- Old DB payloads without `v`: safe.
- Old DB payloads with extra fields: safe.
- Event-type rename or semantic repurpose: unsafe unless a migration/normalizer is added.
- `eventId` and `provider` are stored in separate SQL columns, not in the payload returned to clients.

### Risks

- There is version tagging, but not version migration yet. `v` is currently a marker, not a full evolution system.
- A malformed JSON payload in SQLite still breaks timeline reads.
- Because `eventId` is stripped from the wire event, replay/deduplication across transports is harder than it should be.

### Recommendation

- Keep this model; it is the strongest part of the protocol story.
- Add explicit per-version normalizers:
  - `normalizeEventV1`
  - `normalizeEventV2`
- Keep missing `v` => `1`.
- Expose `eventId` on the wire so future replay, backfill, and dedupe are possible across daemon/dashboard/relay boundaries.

## 4. Provider events

### Current behavior

- Provider runtime events created inside Orka carry `v: 1`.
- Provider-owned enums are intentionally open-ended (`KnownEnum.or(z.string())`), which is good for forward compatibility when providers add new values.
- Unknown provider event types are preserved by `mapProviderEvent()` as `event.passthrough`.
- The consumer only performs special handling for a small subset of event types; everything else falls through safely.

### Compatibility assessment

- New enum values from Claude Code/Codex: generally safe.
- New provider event types: preserved into the orchestration layer instead of being dropped.
- Unknown provider fields: preserved in the raw provider payload inside passthrough.

### Risks

- Passthrough begins at ingestion. If an adapter itself hard-rejects a provider event before building a `ProviderRuntimeEvent`, that data is still lost.
- Provider event `v` is not negotiated with consumers; it is only carried along.

### Recommendation

- Preserve the current open-enum design.
- Standardize an adapter rule:
  - unknown provider event type must still emit a `ProviderRuntimeEvent` wrapper with raw payload
  - adapters must never drop unknown provider events silently
- Add adapter conformance tests for unknown event types and new enum values.

## 5. Relay transport

### Current behavior

- The transport protocol has explicit `v: 1` in `client_hello`, `server_hello`, and `TransportPayload`.
- Negotiation covers Noise suite, app protocol, key ID, node ID, and max frame size.
- If the cleartext hello version is not `1`, the server returns `transport_error: unsupported_version`.
- Relay auth is separate and reasonably strong: API keys, account scoping, rate limits, and Noise encryption after binding.

### Compatibility assessment

- This is versioned, but not future-proof.
- There is no supported version range; transport is exact-match `1`.
- There is no capability negotiation beyond suite/protocol lists.
- Any future incompatible transport change requires lockstep rollout.

### Current correctness gaps

- Relay-mode push is incomplete:
  - in `registerWithRelay()`, secure `push_control` frames are explicitly not supported
  - a relay-routed client therefore cannot subscribe to push channels through the node path
- Relay-mode welcome delivery is malformed:
  - direct daemon connections send `server.welcome` as a proper `PushEnvelope`
  - relay registration currently calls `transport.encryptPush(welcome)` with the raw welcome payload, not a `PushEnvelope`
  - the client decrypts it and drops it because it has no `type/channel/sequence`
- Because `server.welcome` is broken over relay, protocol mismatch detection and capability discovery are unreliable in relay mode.

### Security assessment

- Transport integrity/confidentiality is strong once Noise is established.
- The prologue binds the handshake to the hello transcript and relay origin, which is good.
- Replay protection relies on the Noise transport state, not an explicit message replay cache.
- Relay auth and account isolation are present.

### Recommendation

- Introduce transport version range negotiation:
  - client hello: `min_v`, `max_v`
  - server hello: `selected_v`
- Add transport capabilities/features in negotiated form, not just opaque arrays.
- Fix relay push support before declaring relay forward-compatible:
  - relay path must accept and route `push_control`
  - relay path must deliver a real encrypted `PushEnvelope` for `server.welcome`
- Add a compatibility matrix test: client/relay/daemon mixed-version transport handshake.

## 6. Dashboard <-> daemon HTTP/WS path

### Current behavior

- In local mode, the dashboard assumes same-origin `/ws` and `/v1/traces`.
- Vite dev proxies `/ws` to the daemon and production is designed the same way.
- Relay auth tokens are appended as `?token=` query params when a remote endpoint is used.
- Direct daemon mode has no auth layer; it relies on the daemon binding to `127.0.0.1` by default.

### Compatibility assessment

- Same-origin `/ws` is good for deployment consistency between dev and prod.
- The dashboard does react to push protocol mismatch, but only after `server.welcome`.
- If the daemon is exposed on a non-local interface, there is still no auth on direct HTTP/WS.

### Risks

- Direct daemon access is safe only under the local-trust assumption.
- There is no CORS/auth story for exposing the daemon as a remote multi-user service; that responsibility is effectively delegated to the relay or a reverse proxy.
- Query-param relay tokens are functional but not ideal from an audit/logging perspective.

### Recommendation

- Keep same-origin `/ws` for the dashboard.
- Document clearly that direct daemon WS/HTTP is local-only/trusted-network only.
- If remote daemon exposure is ever supported, add explicit auth and origin policy instead of extending the current unauthenticated path.

## 7. DB schema versioning

### Current behavior

- Daemon DB migrations are Kysely `up` migrations only.
- `runMigrations()` creates a pre-migration backup file when there are pending migrations.
- Legacy schema transition is handled by pre-seeding Kysely migration records.
- Rollback is not wired into startup; no `down` migrations are defined in the daemon migration set.
- Per official Kysely docs, SQLite migrations run inside a transaction because the SQLite adapter reports transactional DDL support:
  - https://kysely-org.github.io/kysely-apidoc/classes/DialectAdapterBase.html
  - https://kysely-org.github.io/kysely-apidoc/classes/SqliteAdapter.html

### Compatibility assessment

- Forward migration: good.
- Mid-migration failure: reasonably safe because of transactional DDL plus backup.
- Automated rollback/downgrade: not supported.
- Old binary against newer DB: not guaranteed. It may work for purely additive schema changes, but there is no supported downgrade contract.

### Risks

- Backups are manual rollback material, not an automated downgrade story.
- Data migrations are forward-oriented; once a migration changes semantics, older binaries may misread data.

### Recommendation

- State explicitly that the daemon DB schema is forward-only.
- Keep automatic backups before pending migrations.
- Add a supported recovery procedure:
  - stop daemon
  - restore `orka.db.bak-vN`
  - start a matching daemon version
- Only promise old-binary/new-DB compatibility when a migration is declared additive and tested that way.

## Risk matrix

| Upgrade scenario | What happens today | Risk |
| --- | --- | --- |
| Old CLI -> new daemon (direct) | Usually works for additive changes; extra fields are ignored | Low |
| New CLI -> old daemon (direct) | New methods fail at call time with `-32601`; only some commands degrade gracefully | Medium |
| Old dashboard -> new daemon (direct) | Additive push/event fields usually survive; unknown events become ignored or passthrough | Low |
| New dashboard -> old daemon (direct) | Works until dashboard uses a new RPC/push feature; mismatch banner only appears if `protocolVersion` changes | Medium |
| Any client -> daemon after push protocol major bump | Hard mismatch because range is currently exactly `1..1` | High |
| Any client -> relay/daemon with transport protocol bump | Handshake fails with `unsupported_version` | High |
| Relay-routed client needing push updates | Broken today for secure push control and malformed relay welcome | High |
| Daemon upgrade with pending DB migrations | Usually safe; startup backup plus transactional SQLite migrations | Medium |
| Daemon downgrade after DB migration | Manual restore only; not a supported seamless path | High |
| Remote exposure of direct daemon HTTP/WS | No direct auth; safe only under local/trusted deployment assumptions | High |

## Recommended versioning strategy

### Separate software version from protocol version

Use three distinct concepts:

- `serverVersion`: semver of the Orka binary/package
- `controlPlaneVersion`: selected version for RPC + push
- `transportVersion`: selected version for relay/Noise transport

Do not use package semver as the wire compatibility contract.

### Control-plane strategy

- Client advertises supported range on connection.
- Server responds with:
  - `selected`
  - `minSupported`
  - `maxSupported`
  - capabilities/features
- Rule within one control-plane major:
  - additive fields only
  - additive methods only
  - additive push channels only
  - no field renames or removals

### Event strategy

- Keep per-event `v`.
- Missing `v` always means `1`.
- Add version-specific normalizers at the read boundary.
- Never repurpose an existing field in place; add a new field or new event version.

### Transport strategy

- Replace exact `v: 1` matching with range negotiation.
- Keep hello negotiation separate from software semver.
- Treat new features as negotiated capabilities, not implicit by version alone.

## Upgrade playbook

### Safe upgrade path for today

1. Upgrade relays first.
2. Upgrade daemons second.
3. Upgrade dashboards and CLIs last.

This order minimizes `new client -> old server` failures.

### Safe upgrade path after the recommended changes

1. Ship relay/daemon versions that understand both protocol majors.
2. Keep old and new push/event shapes readable at the boundary.
3. Add server-advertised capability flags before clients rely on new methods.
4. Roll out new clients only after the server side advertises support.
5. Remove old protocol support only after telemetry shows the old major is unused.

### Downgrade/recovery playbook

For daemon DB issues:

1. Stop the daemon.
2. Restore the most recent `orka.db.bak-vN`.
3. Start the daemon version that matches that schema generation.
4. Reconnect dashboards/CLIs and refetch state.

For push or relay compatibility issues:

1. Fall back to direct daemon connections where possible.
2. Force a dashboard reload so it refetches full state.
3. Avoid relying on gap recovery; it is not implemented as data repair today.

## Priority recommendations

1. Fix relay push completeness: support encrypted `push_control` and send a real encrypted `server.welcome` envelope in relay mode.
2. Add negotiated version ranges for control-plane and transport protocols.
3. Introduce a stable `getServerInfo`/capabilities contract and stop relying on `MethodNotFoundError` as the main upgrade mechanism.
4. Keep orchestration events as the compatibility backbone, but add explicit per-version normalizers and expose `eventId` on the wire.
5. Document the DB as forward-only and keep backup-based recovery as the downgrade path until explicit rollback support exists.
