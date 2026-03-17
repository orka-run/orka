# Unified Session Creation UX

## Problem

Two code paths for spawning sessions from the dashboard:

1. **DraftChatView** — inline chat input, fast, but missing tags, title, systemPrompt, permissionMode selector, autoMerge, node selector. Hardcodes `permissionMode: "supervised"`, `autoMerge: false`.
2. **NewSessionDialog** — modal with all options, but interrupts flow. User loses context switching between chat and modal.

Additional issues:
- When DraftChatView spawns, user sees a brief pending message, then a jarring switch to SessionView (blank until timeline loads).
- "Advanced..." button in DraftChatView opens the full modal, which duplicates the prompt input and requires re-entering the message.
- No seamless visual continuity from "drafting a prompt" to "session running".

## Decision: Merge into unified DraftChatView with inline options

**Delete NewSessionDialog.** Extend DraftChatView with collapsible inline advanced options. The chat input IS the spawn form — no separate modal needed.

Rationale:
- The "quick spawn" and "advanced spawn" distinction is artificial. Users who want tags or a system prompt shouldn't need a modal.
- A collapsible options panel inside the chat view gives progressive disclosure without context switching.
- On mobile, a bottom-sheet-style options panel works better than a full-screen modal.
- The seamless transition (message appears, session starts, events flow in) only works if spawn happens from the chat view.

## Wireframes

### Desktop — empty state (no advanced options)

```
+--[ Sidebar ]--+--[ Main Content ]----------------------------+
|               |                                               |
| Sessions...   |  [claude-code|codex] [model v] [bg|int] |
|               |                         [Options v] ← toggle  |
|               |                                               |
|               |         +-----------------------------+       |
|               |         |   (chat bubble icon)        |       |
|               |         |   New session               |       |
|               |         |   Send a message to start   |       |
|               |         +-----------------------------+       |
|               |                                               |
|               |  +------------------------------------------+ |
|               |  | Describe the work...         [Send]       | |
|               |  +------------------------------------------+ |
+---------------+-----------------------------------------------+
```

### Desktop — advanced options expanded

```
+--[ Sidebar ]--+--[ Main Content ]----------------------------+
|               |                                               |
|               |  [claude-code|codex] [model v] [bg|int] |
|               |                         [Options ^] ← toggle  |
|               |  +------------------------------------------+ |
|               |  | Title: [optional________________]         | |
|               |  | Tags:  [frontend, urgent________]         | |
|               |  | Permissions: [bypass|supervised|auto]     | |
|               |  | [x] Auto-merge                            | |
|               |  | System prompt: [________________]         | |
|               |  | Node: [auto|node-1|node-2]      (if >1)  | |
|               |  +------------------------------------------+ |
|               |                                               |
|               |         +-----------------------------+       |
|               |         |   New session               |       |
|               |         |   Send a message to start   |       |
|               |         +-----------------------------+       |
|               |                                               |
|               |  +------------------------------------------+ |
|               |  | Describe the work...         [Send]       | |
|               |  +------------------------------------------+ |
+---------------+-----------------------------------------------+
```

### Desktop — after send (spawning)

```
+--[ Sidebar ]--+--[ Main Content ]----------------------------+
|               |                                               |
| > sess-abc123 |                                               |
|   Sessions... |        [User bubble]                          |
|               |        "Fix the login bug in auth.ts"         |
|               |                                               |
|               |   [Bot icon] Starting session...              |
|               |              (spinner)                        |
|               |                                               |
|               |  +------------------------------------------+ |
|               |  | Session is starting...       [Send]       | |
|               |  +------------------------------------------+ |
+---------------+-----------------------------------------------+
```

### Desktop — session running (events flowing in)

```
+--[ Sidebar ]--+--[ Main Content ]----------------------------+
|               |  [Overview] [Chat*] [Logs] [Diff]  [Stop]     |
| > sess-abc123 |                                               |
|   Sessions... |        [User bubble]                          |
|               |        "Fix the login bug in auth.ts"         |
|               |                                               |
|               |   [Bot] I'll look at auth.ts...               |
|               |   [Tool] Read auth.ts (14 lines)              |
|               |   [Bot] Found the issue. The token...         |
|               |                                               |
|               |   [ApprovalCard] File Edit: auth.ts           |
|               |     [Approve] [Deny]          elapsed: 3s     |
|               |                                               |
|               |  +------------------------------------------+ |
|               |  | Agent is working...          [Stop]       | |
|               |  +------------------------------------------+ |
+---------------+-----------------------------------------------+
```

### Mobile — empty state

```
+-----------------------------------------------+
| Orka                                          |
+-----------------------------------------------+
| [claude-code|codex] [model] [bg|int]    |
|                              [Options v]      |
+-----------------------------------------------+
|                                               |
|           (chat bubble icon)                  |
|           New session                         |
|           Send a message to start             |
|                                               |
+-----------------------------------------------+
| Describe the work...               [Send]     |
+-----------------------------------------------+
| [Sessions] [Chat] [Logs] [Diff] [Info]        |
+-----------------------------------------------+
```

### Mobile — options expanded (bottom sheet style)

```
+-----------------------------------------------+
| Orka                                          |
+-----------------------------------------------+
| [claude-code|codex] [model] [bg|int]    |
|                              [Options ^]      |
+-----------------------------------------------+
| Title: [optional_________________]            |
| Tags:  [frontend, urgent_________]            |
| Permissions: [bypass|supervised|auto]         |
| [x] Auto-merge                                |
| System prompt: [_________________]            |
+-----------------------------------------------+
| Describe the work...               [Send]     |
+-----------------------------------------------+
| [Sessions] [Chat] [Logs] [Diff] [Info]        |
+-----------------------------------------------+
```

## Component Architecture

### Before (current)

```
App
├── DraftChatView (quick spawn, minimal options)
│   ├── MiniPills (backend, mode)
│   ├── select (model)
│   └── ChatInputComposer
├── NewSessionDialog (modal, all options)
│   ├── ToggleButton groups
│   └── Advanced section
└── SessionView (selected session)
    ├── SessionHeader (tabs, controls)
    └── ChatView (timeline, approvals)
```

### After (unified)

```
App
├── DraftChatView (unified spawn, all options inline)
│   ├── SpawnOptionsBar (backend, model, mode pills — always visible)
│   ├── SpawnAdvancedPanel (collapsible: title, tags, permissions, autoMerge, systemPrompt, node)
│   ├── DraftTimeline (pending message + spinner during spawn)
│   └── ChatInputComposer (reused as-is)
└── SessionView (selected session — unchanged)
    ├── SessionHeader
    └── ChatView
```

### New/modified components

| Component | Status | Description |
|-----------|--------|-------------|
| `DraftChatView` | **modify** | Add inline advanced options, remove `onOpenAdvanced` prop |
| `SpawnOptionsBar` | **extract** | Backend pills + model dropdown + mode pills (already in DraftChatView header, extract for reuse) |
| `SpawnAdvancedPanel` | **new** | Collapsible panel: title, tags, permissions, autoMerge, systemPrompt, node selector |
| `NewSessionDialog` | **delete** | All functionality absorbed into DraftChatView |
| `App.tsx` | **modify** | Remove NewSessionDialog, advancedDefaults state, handleOpenAdvanced |

## Data Flow

### Spawn flow (unified)

```
User types prompt in DraftChatView
  → User hits Enter (or Cmd+Enter)
  → DraftChatView captures: prompt + all option state (backend, model, mode, title, tags, permissionMode, autoMerge, systemPrompt, nodeId)
  → setPendingMessage(text) — user message appears immediately as chat bubble
  → setIsSpawning(true)
  → spawnSession(transport, request)
    → transport.request("spawn", fullRequest)
    → Store creates SessionSummary, sets selectedId = newId
    → Store returns sessionId
  → onSpawned() callback fires
    → App sets isDraftActive = false
    → App renders SessionView for the new sessionId
    → SessionView/ChatView loads timeline (user's prompt is first event)
    → Real events flow in via push subscription
```

### Seamless transition strategy

The current approach already works reasonably well: `spawnSession` immediately creates a `SessionSummary` in the store and selects it. The perceived gap comes from ChatView's initial timeline fetch. Two improvements:

1. **Optimistic timeline entry**: When `spawnSession` returns the sessionId, `DraftChatView` can pre-seed the timeline cache with a synthetic user-message entry before calling `onSpawned()`. This way, when ChatView mounts, it immediately shows the user's prompt from cache while the real timeline loads.

2. **Stale-while-revalidate already works**: The timeline cache already supports this pattern (prefetch on hover). The same mechanism can serve the optimistic entry.

```typescript
// In DraftChatView, after spawnSession returns:
const sessionId = await spawnSession(transport, request);

// Pre-seed timeline cache with the user's prompt
useTimelineCache.getState().seed(sessionId, [{
  type: "user.message",
  content: text,
  timestamp: new Date().toISOString(),
}]);

onSpawned(); // App switches to SessionView, ChatView uses cached entry
```

This requires adding a `seed(sessionId, entries)` method to `timelineCache.ts` — a trivial addition.

## State Management

### DraftChatView state (after unification)

```typescript
// Quick options (always visible in header bar)
backend: BackendKind           // "claude-code" (default)
model: string                  // "" (default model)
mode: SessionMode              // "background" (default)

// Advanced options (collapsible panel)
title: string                  // ""
tags: string                   // "" (comma-separated)
permissionMode: PermissionMode // "supervised" (default)
autoMerge: boolean             // false (default)
systemPrompt: string           // ""
targetNode: string             // "" (auto)

// Spawn state
isSpawning: boolean
pendingMessage: string | null
spawnError: string | null

// UI state
showAdvanced: boolean          // false (collapsed by default)
```

### Default propagation

Defaults come from three sources, in priority order (highest wins):

1. **Per-spawn UI state** — whatever the user sets in the current DraftChatView
2. **Sticky defaults from localStorage** — last-used values for backend, model, mode, permissionMode (persisted on successful spawn)
3. **Hardcoded defaults** — `backend: "claude-code"`, `mode: "background"`, `permissionMode: "supervised"`, `autoMerge: false`

Implementation:

```typescript
const DRAFT_DEFAULTS_KEY = "orka:draftDefaults";

interface DraftDefaults {
  backend: BackendKind;
  model: string;
  mode: SessionMode;
  permissionMode: PermissionMode;
  autoMerge: boolean;
}

function loadDraftDefaults(): Partial<DraftDefaults> {
  try {
    const raw = localStorage.getItem(DRAFT_DEFAULTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDraftDefaults(defaults: DraftDefaults): void {
  try { localStorage.setItem(DRAFT_DEFAULTS_KEY, JSON.stringify(defaults)); }
  catch { /* ignore */ }
}
```

On successful spawn, persist the current settings. On mount, load them as initial state.

Future: project-level defaults from `.orka.toml` can override hardcoded defaults. Not needed now since config layering isn't wired to the dashboard yet.

## Supervised Permissions Integration

Approval cards already appear inline in ChatView via the `request.opened` / `request.resolved` orchestration events. No changes needed for the approval flow itself.

The key UX improvement: **the permissions selector is now visible in the DraftChatView advanced panel**, so users can choose supervised/bypass/auto before spawning. Previously, DraftChatView hardcoded `supervised` with no way to change it without opening the modal.

Flow:
```
User sets permissionMode = "supervised" (default)
  → Spawns session
  → Agent hits a permission check (file edit, command run)
  → Daemon emits request.opened event
  → ChatView renders ApprovalCard inline
  → User approves/denies via buttons
  → Dashboard sends resolveApproval(requestId, decision)
  → Agent continues/aborts
```

No changes to ApprovalCard, the approval RPC, or the daemon-side hook system.

## "Session Starting..." State

Currently, DraftChatView shows:
```
[User bubble] "Fix the login bug..."
[Bot icon] Starting session... (spinner)
```

This is already good. The improvement is that this state persists only until `onSpawned()` fires, at which point the view switches to SessionView. With the optimistic timeline seed, the transition is near-instant: the user sees their message in DraftChatView, then the same message in ChatView (from cache), then real events flow in.

The "starting session" spinner should also show in ChatView's thinking indicator when the session status is `preparing` or `queued`. ChatView already handles this via `inputState: "not_started"` from `useInputState`.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Spawn RPC fails (network) | Error banner below input, pending message cleared, user can retry |
| Spawn RPC fails (validation) | Same — error message from daemon shown inline |
| Session fails immediately after spawn | SessionView loads, shows `failed` status badge, error in timeline |
| WebSocket disconnects during spawn | ConnectionBanner shows reconnection status, spawn may timeout |
| User clicks Send while spawning | Button disabled, input shows "Session is starting..." |

### Retry from same prompt

When spawn fails, the prompt text stays in the input (it's restored from `pendingMessage`). The user can edit and retry without re-typing. The error clears on next keystroke (existing behavior from `onClearError`).

For retry of completed/failed sessions, SessionView already has a Retry button that calls `retrySession`. No changes needed.

## Migration Steps

### Phase 1: Add inline advanced options to DraftChatView

1. Create `SpawnAdvancedPanel` component with: title, tags, permissions, autoMerge, systemPrompt, node selector
2. Add `showAdvanced` toggle state to DraftChatView
3. Wire all advanced fields into the `SpawnRequest` built by `handleSend`
4. Add `nodes` prop to DraftChatView (needed for node selector)
5. Add sticky defaults (load/save to localStorage)

### Phase 2: Seamless transition

1. Add `seed(sessionId, entries)` to `timelineCache.ts`
2. In DraftChatView's `handleSend`, after `spawnSession` returns, seed the cache with the user's prompt
3. Verify ChatView picks up the seeded entry on mount

### Phase 3: Delete NewSessionDialog

1. Remove `NewSessionDialog` component file
2. Remove from App.tsx: `isNewSessionOpen`, `advancedDefaults`, `handleOpenAdvanced`, `NewSessionDialog` import/render
3. Remove `onOpenAdvanced` prop from DraftChatView
4. Remove `DraftSettings` export (no longer needed)
5. Update App.tsx: Ctrl+N just activates draft (already does this)

### Phase 4: Polish

1. Mobile testing — ensure options panel works with bottom tab bar and safe areas
2. Keyboard shortcuts — Enter to send (already works), Escape to collapse options
3. Accessibility — proper labels and aria attributes on new fields
4. Tracing — update span attributes to include all new fields

## Files Changed

| File | Action | Notes |
|------|--------|-------|
| `DraftChatView.tsx` | modify | Add advanced panel, sticky defaults, nodes prop, timeline seeding |
| `SpawnAdvancedPanel.tsx` | create | Extracted collapsible panel component |
| `NewSessionDialog.tsx` | delete | Fully replaced |
| `App.tsx` | modify | Remove dialog state, pass nodes to DraftChatView |
| `timelineCache.ts` | modify | Add `seed()` method |
| `sessionStore.ts` | no change | `spawnSession` already handles the full `SpawnRequest` |

## What This Does NOT Change

- SessionView, ChatView, ApprovalCard — untouched
- Approval flow (hook-based supervised permissions) — untouched
- Session store — untouched
- Transport layer — untouched
- Sidebar — untouched (already has "New Session" button that calls `activateDraft`)
- CLI spawn (`orka spawn`) — untouched
