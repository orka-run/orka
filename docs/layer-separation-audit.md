# Layer Separation Audit

Audit of type sharing anti-patterns across DB, domain, API, and dashboard layers.

## Executive Summary

The `Session` type is the central offender — it serves as DB row output, domain model, API response, and dashboard input simultaneously. This causes: oversized API payloads, leaked server internals (file paths), a type-safety hole where the interface lies about return types, and tight coupling that makes it hard to evolve any layer independently.

**Severity**: 7 findings, 3 high-impact, 2 medium, 2 low.

---

## Finding 1: `listSessions()` Interface Lies About Return Type

**Severity**: High
**Files**:
- `packages/core/src/service.ts:128` — declares `listSessions(): Promise<Session[]>`
- `packages/daemon/src/local-client.ts:99-112` — returns `SessionListItem[]` (non-tag path) or `Session[]` (tag path)
- `packages/dashboard/src/stores/sessionStore.ts:46` — `toSessionSummary()` expects `session.title`, `session.model`, `session.prompt`

**What's wrong**: The OrkaService interface declares `Promise<Session[]>` but the implementation returns `SessionListItem[]` on the non-tag path (via `db.listSessionItems()`). `SessionListItem extends Session` so TypeScript doesn't complain, but:

1. The **tag path** returns plain `Session[]` (no title/model/prompt) — behavioral inconsistency
2. The dashboard **relies on** `title`, `model`, `prompt` fields that aren't in the declared type
3. `toSessionSummary()` uses `session.title ?? session.id` — silently falls back when fields are missing

**Impact**: Tag-filtered sessions show ID instead of title in the dashboard. Any consumer trusting the interface type will miss available fields.

**Fix**: Change interface to `listSessions(): Promise<SessionListItem[]>`. Fix the tag path to also use a JOIN query. **Complexity**: S

---

## Finding 2: `Session` Exposes Server Internals to All Consumers

**Severity**: High
**Files**:
- `packages/core/src/types.ts` — Session type definition
- `packages/daemon/src/db.ts` — `rowToSession()` maps all DB fields

**What's wrong**: `Session` includes fields that are server-internal and meaningless (or security-sensitive) to API consumers:

| Field | Why it's internal |
|-------|-------------------|
| `workspaceId` | FK to workspaces table, no meaning to clients |
| `logFile` | Server filesystem path (`~/.orka/logs/sess-xxx.log`) |
| `rawLogFile` | Server filesystem path |
| `systemPrompt` | Potentially large, only needed for retry/detail |
| `allowedTools` | Array of tool names, only needed for detail |
| `env` | **Security-sensitive** environment variables |
| `taskId` | FK reference, redundant when title/prompt are inlined |

**Impact**:
- `env` field leaks environment variables (API keys, tokens) to any dashboard user
- File paths expose server directory structure
- Every API response carries ~6 unnecessary fields, increasing payload size
- Tight coupling: changing DB schema (e.g., renaming `log_file`) requires updating all consumers

**Fix**: Create `SessionResponse` DTO (API layer) and `SessionDetailResponse` DTO. Never expose `env` or filesystem paths over the wire. **Complexity**: M

---

## Finding 3: `Session` Is DB Entity, Domain Model, and API Response

**Severity**: High
**Files**:
- `packages/core/src/types.ts` — Single `Session` type
- `packages/daemon/src/db.ts` — `rowToSession()` returns `Session`
- `packages/core/src/service.ts` — `getSession()`, `spawn()`, `listSessions()` all return `Session`
- `packages/dashboard/src/stores/sessionStore.ts` — consumes `Session`

**What's wrong**: One type spans all four layers:
```
DB row → rowToSession() → Session → RPC JSON → Session → toSessionSummary() → SessionSummary
```

This means:
- Adding a DB column forces a change to the API contract
- The API response shape is dictated by DB schema
- No place to add API-specific fields (e.g., computed durations, URLs) without polluting the domain
- No place to redact fields (e.g., `env`) without a DTO

**Impact**: Inability to evolve DB schema, domain logic, and API independently. Every change ripples across all layers.

**Fix**: Introduce layer-specific types:
- `SessionRow` — DB layer (stays in daemon/db.ts, not exported)
- `Session` — Domain model (core/types.ts, no change)
- `SessionResponse` / `SessionListResponse` — API layer (core/service.ts)
- `SessionSummary` — Dashboard layer (already exists, properly separated)

**Complexity**: L (touches many files, but mechanical)

---

## Finding 4: `OrchestrationEvent` Is DB Payload, Wire Format, and UI Data

**Severity**: Medium
**Files**:
- `packages/core/src/orchestration.ts` — `OrchestrationEvent` union type + `WireOrchestrationEventSchema`
- `packages/daemon/src/db.ts` — stored as JSON in `payload` column
- `packages/daemon/src/orchestration/engine.ts` — broadcasts via PushHub
- `packages/core/src/push-protocol.ts` — `orchestration.event` channel carries raw events
- `packages/dashboard/src/` — ChatView consumes events directly

**What's wrong**: The same `OrchestrationEvent` type is:
1. **Persisted** in SQLite (JSON serialized)
2. **Broadcast** over WebSocket push
3. **Returned** via `getSessionTimeline()` RPC
4. **Consumed** by dashboard ChatView and eventsToEntries()

There is a `WireOrchestrationEventSchema` for parsing, but no separate wire/API representation. The internal event structure IS the API contract.

**Impact**:
- Cannot add internal-only fields to events (e.g., debugging metadata) without exposing to clients
- No versioning boundary — changing event shape breaks dashboard immediately
- `getSessionTimeline()` returns the entire event history with no pagination
- Large sessions can have thousands of events; no way to get a count or summary without loading all

**Mitigating factor**: `parseWireEvent()` with Zod provides forward compatibility (unknown event types accepted). This is actually well-designed for schema evolution.

**Fix**:
- Short term: Add pagination to `getSessionTimeline()` (offset/limit)
- Medium term: Consider a `TimelineEvent` wire type that strips internal fields and adds computed fields (duration, etc.)
- The existing `parseWireEvent()` pattern is good — keep it

**Complexity**: M

---

## Finding 5: `spawn()` Returns Full `Session` When Only ID Is Needed

**Severity**: Low
**Files**:
- `packages/core/src/service.ts` — `spawn(req: SpawnRequest): Promise<Session>`
- `packages/daemon/src/local-client.ts` — constructs and returns full Session
- `packages/dashboard/src/stores/sessionStore.ts:162` — only uses `id` and a few fields

**What's wrong**: `spawn()` returns a full `Session` object, but callers typically only need:
- CLI: `session.id` (to print and for `orka wait`)
- Dashboard: `session.id` + status (then fetches detail separately)

The full Session includes `logFile`, `workspaceId`, `env`, etc. — all unnecessary at spawn time.

**Impact**: Minor over-the-wire waste. More importantly, the spawn response carries `env` (security-sensitive) back to the client.

**Fix**: Return `SpawnResponse { id: SessionId; status: SessionStatus }` or at minimum redact `env`. **Complexity**: S

---

## Finding 6: `getChildSessions()` Returns Plain `Session[]` (No Task Info)

**Severity**: Low
**Files**:
- `packages/daemon/src/local-client.ts:115` — `return this.ctx.db.getChildSessions(parentId)`
- `packages/daemon/src/db.ts` — `getChildSessions()` returns `Session[]` (no JOIN with tasks)

**What's wrong**: Unlike `listSessions()` (which uses `listSessionItems()` with a JOIN), `getChildSessions()` returns bare `Session[]` without title/model/prompt. Any UI showing child sessions would need N+1 `getTask()` calls, which is the same bug we just fixed for the main list.

**Impact**: Not currently visible (child sessions aren't prominently displayed), but will be a problem when parent/child session trees are shown in the UI.

**Fix**: Create `listChildSessionItems()` with the same JOIN pattern as `listSessionItems()`. **Complexity**: S

---

## Finding 7: Dashboard `SessionSummary` Strips Fields That Shouldn't Exist on API Response

**Severity**: Medium
**Files**:
- `packages/dashboard/src/stores/sessionStore.ts:45-70` — `toSessionSummary()` function

**What's wrong**: `toSessionSummary()` is a mapping function that:
1. Copies ~15 fields from the API response
2. Drops ~8 fields (`workspaceId`, `logFile`, `rawLogFile`, `systemPrompt`, `allowedTools`, `env`, `parentSessionId`, `archivedAt`)
3. Adds `nodeId` (multi-node routing)

This mapping exists **because the API response is too large**. If the API returned a proper list DTO, this function would be trivial or unnecessary.

**Impact**: Maintenance burden — every new Session field must be consciously included or excluded in the mapper. Easy to accidentally expose or lose data.

**Fix**: This is a symptom of Finding 2/3. Once the API returns a proper `SessionListResponse`, the dashboard mapper simplifies dramatically. **Complexity**: Resolved by Findings 2+3

---

## Additional Observations

### Tag path inconsistency (related to Finding 1)

`listSessionsByTag()` in db.ts returns `Session[]` (no task JOIN), while the non-tag `listSessionItems()` returns `SessionListItem[]`. This means tag-filtered views in the dashboard silently degrade — sessions show IDs instead of titles.

### No DTO for `getResult()`

`SessionResult` is clean and purpose-built — it's already a proper API response type. However, the `result` field contains full stdout text which can be very large. The dashboard overview tab doesn't use it. Consider splitting into `SessionResultSummary` (metadata only) and `SessionResultFull` (with text).

### `captureOutput()` returns unbounded string

No pagination or streaming. For long-running sessions, this could be megabytes. Not a type-sharing issue per se, but a related API design concern.

---

## Migration Plan

### Phase 1: Quick Wins (S complexity, do immediately)

**1.1 Fix interface type for listSessions**
- Change `OrkaService.listSessions()` return type from `Session[]` to `SessionListItem[]`
- Add `listChildSessionItems()` to DB with same JOIN pattern
- Fix tag path to use JOIN query
- Files: `core/service.ts`, `daemon/db.ts`, `daemon/local-client.ts`

**1.2 Redact `env` from API responses**
- Strip `env` field in `rowToSession()` or add a `toApiSession()` mapper
- `env` contains secrets and should never cross the wire
- Files: `daemon/local-client.ts` (add redaction before return)

**1.3 Fix spawn response**
- Return only `{ id, status }` from `spawn()` or at minimum strip `env`
- Files: `core/service.ts`, `daemon/local-client.ts`

### Phase 2: Proper Layer Separation (M complexity, next sprint)

**2.1 Create API response DTOs**
```typescript
// core/service.ts — API layer types

/** Returned by listSessions() — optimized for list views */
interface SessionListResponse {
  id: SessionId;
  status: SessionStatus;
  backend: BackendKind;
  mode: SessionMode;
  title: string;
  model: string | null;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  projectPath: string;
  kept: boolean;
  autoMerge: boolean;
  tags: string[];  // Inline tags to avoid separate getTags() calls
}

/** Returned by getSession() — full detail view */
interface SessionDetailResponse extends SessionListResponse {
  workingDir: string;
  parentSessionId: string | null;
  systemPrompt: string | null;
  allowedTools: string[] | null;
  archivedAt: string | null;
  // Note: env, logFile, rawLogFile, workspaceId, taskId deliberately omitted
}
```

**2.2 Update OrkaService interface**
```typescript
listSessions(filters?: SessionFilters): Promise<SessionListResponse[]>;
getSession(id: string): Promise<SessionDetailResponse | null>;
spawn(req: SpawnRequest): Promise<{ id: SessionId; status: SessionStatus }>;
```

**2.3 Simplify dashboard mapper**
- `toSessionSummary()` becomes trivial (just adds `nodeId`)
- `SessionSummary` aligns closely with `SessionListResponse`

### Phase 3: Event Layer Separation (M complexity, when needed)

**3.1 Add pagination to getSessionTimeline()**
```typescript
getSessionTimeline(
  sessionId: string,
  opts?: { offset?: number; limit?: number; types?: string[] }
): Promise<{ events: OrchestrationEvent[]; total: number }>;
```

**3.2 Add result summary endpoint**
```typescript
getResultSummary(sessionId: string): Promise<SessionResultSummary | null>;
// Returns cost, tokens, duration, model, numTurns — no full text
```

**3.3 Consider wire event type (optional)**
- Only if internal events need fields that shouldn't be exposed
- Current `parseWireEvent()` pattern handles forward compatibility well
- Low priority unless we add internal debugging metadata to events

---

## Rules to Add to CLAUDE.md

```markdown
## Layer Separation

### Type Layers
- **DB Row types** (`*Row` schemas) — stay in `daemon/db.ts`, never exported
- **Domain types** (`Session`, `Task`, etc.) — in `core/types.ts`, used for internal logic
- **API response types** (`*Response` DTOs) — in `core/service.ts`, returned by OrkaService
- **Dashboard types** (`SessionSummary`, etc.) — in `dashboard/src/stores/`, derived from API responses

### Rules
1. **Never return a domain type directly from an API method.** Use a response DTO.
2. **Never expose DB row shapes to API consumers.** Map to domain first, then to response DTO.
3. **Never include filesystem paths in API responses** (`logFile`, `rawLogFile`, `workingDir` for non-detail views).
4. **Never include `env` in API responses.** Environment variables are security-sensitive.
5. **List endpoints return summary DTOs**, not full objects. Detail endpoints return full DTOs.
6. **If a dashboard mapper strips fields from the API response, the API response is too large.**
```
