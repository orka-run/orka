# Workspaces Plan — Project-Level Session Grouping

## Problem

Sessions are a flat list. Users work on multiple projects simultaneously. Finding "my orka sessions" vs "my frontend sessions" requires `--project` filtering in CLI or manual scanning in the dashboard. There's no visual grouping, no per-project stats, and no workspace-aware defaults.

## Definition

A **workspace** = a project directory identified by `projectPath` on sessions. Workspaces are not a new entity — they are derived from existing session data and project aliases.

---

## Current State

| Feature | Status |
|---|---|
| `session.projectPath` | Stored in DB, returned in `SessionListResponse` |
| `orka ps --project <path\|alias>` | Works — resolves via `projects.json` |
| `orka project add/remove/list` | Works — aliases in `~/.orka/projects.json` |
| Dashboard session list | Flat, sorted by `createdAt` desc |
| Dashboard filtering | Text search (id, title, backend, status, model, nodeId) |
| Dashboard grouping | Node-based only (`selectedNodeId`) |
| Per-project config | `.orka.toml` in project root, merged over `~/.orka/config.toml` |

**Gap:** No project grouping in dashboard. No project-aware CLI defaults. No workspace stats.

---

## Phase 1: Dashboard Client-Side Grouping

**Goal:** Group sessions by project in the sidebar. No backend changes.

### 1.1 Workspace Derivation

Extract workspaces client-side from `SessionSummary[]`:

```typescript
// stores/workspaceStore.ts
interface Workspace {
  /** Absolute project path (primary key) */
  path: string;
  /** Display name: project alias or last path component */
  name: string;
  /** Count of sessions in non-terminal status */
  activeCount: number;
  /** Total session count */
  totalCount: number;
  /** Most recent session createdAt */
  lastActivity: string;
}
```

Derivation logic:
1. Group `sessions` by `projectPath`
2. For each unique path, compute `name`:
   - If a project alias matches (from a new `listProjects()` RPC), use alias name
   - Else use last path component (e.g., `/home/user/prj/orka` → `orka`)
3. Sort workspaces by `lastActivity` desc (most recently active first)
4. Sessions with empty `projectPath` go into an "Ungrouped" workspace

### 1.2 Workspace Store

New Zustand store: `workspaceStore.ts`

```typescript
interface WorkspaceState {
  /** null = "All projects" (default) */
  selectedPath: string | null;
  setSelectedPath(path: string | null): void;
}
```

Workspace list itself is a **derived value** (computed from sessionStore), not duplicated state. Use a selector or `useMemo` in components:

```typescript
function useWorkspaces(): Workspace[] {
  const sessions = useSessionStore((s) => s.sessions);
  return useMemo(() => deriveWorkspaces(sessions), [sessions]);
}
```

### 1.3 Sidebar Workspace Switcher

Add a workspace selector between the node selector and search box.

```
┌─ Sidebar ──────────────────────────────────┐
│ orka | 4 active / 12 total | [+New] [⚙]   │
├────────────────────────────────────────────┤
│ [All nodes] [node1] [node2]                │  ← existing
├────────────────────────────────────────────┤
│ [All ▾]  [orka (3)]  [frontend (1)]  [api] │  ← NEW workspace pills
├────────────────────────────────────────────┤
│ [🔍 Search sessions                   ]    │
├────────────────────────────────────────────┤
│ • Session 1 ...                            │
│ • Session 2 ...                            │
└────────────────────────────────────────────┘
```

**Design:**
- Horizontal scrollable pill bar (like node selector)
- "All" pill always first, shows total active count
- Each workspace pill: `name (activeCount)` — active count only, not total
- Selected pill gets accent background
- Clicking a pill sets `workspaceStore.selectedPath`
- Overflow: horizontal scroll with fade edges (same pattern as node selector)
- Only show the workspace bar when `workspaces.length > 1`

**Filtering pipeline** (order matters):
1. Node filter (`selectedNodeId`)
2. **Workspace filter** (`selectedPath`) — NEW
3. Search query
4. Sort by `createdAt` desc

### 1.4 Session List Group Headers (Alternative to Pills)

If the user selects "All", sessions could optionally show lightweight group headers:

```
┌────────────────────────────────────────────┐
│ orka                                    3 ▾│  ← collapsible group header
│   • Refactor auth middleware    running  2m │
│   • Fix relay reconnect        done     5m │
│   • Add workspace plan         running  1m │
│ frontend                                1 ▾│
│   • Dashboard workspace UI     running  3m │
│ api-server                              2 ▾│
│   • Rate limiter bug           done    12m │
│   • Add pagination             done    20m │
└────────────────────────────────────────────┘
```

**Implementation:**
- When `selectedPath === null` and `workspaces.length > 1`, insert group header items into the virtual list
- Group header: project name (bold) + session count, right-aligned
- Groups sorted by `lastActivity` desc
- Groups are collapsible (toggle in `workspaceStore`)
- Virtual list item types: `"session"` | `"group-header"`
- Group header height: 32px (vs 48px for sessions)

**Decision:** Implement pills first (simpler). Group headers as follow-up if users want the "All" view to be more structured.

### 1.5 Sidebar Header Active Count

Update the header to be workspace-aware:

- "All": `4 active / 12 total` (current behavior)
- Workspace selected: `2 active / 5 total · orka`

### 1.6 URL State

Encode workspace in hash:

```
#workspace=orka                        (workspace selected, no session)
#workspace=orka&session=sess-abc123    (workspace + session)
#session=sess-abc123                   (no workspace filter, session selected)
```

Parse on load → restore `workspaceStore.selectedPath` and `sessionStore.selectedId`.

### 1.7 Mobile

- Workspace pills appear above the session list in `MobileSidebarDrawer`
- Same horizontal scroll behavior
- `MobileHeader` title: show workspace name if one is selected (e.g., "orka" instead of session title when no session is selected)

### 1.8 DraftChatView Workspace Context

When spawning from dashboard with a workspace selected:
- Pre-fill project path from `selectedPath`
- Show workspace name in the header: "New session · orka"
- The `SpawnRequest` should include the workspace's `projectPath` so the daemon spawns in the right directory

This requires a new field on `SpawnRequest` (see Phase 2).

### 1.9 Persistence

- `selectedPath` persisted to `localStorage:orka:selectedWorkspace`
- Restore on page load (after session fetch, validate path still has sessions)

---

## Phase 2: API-Level Workspace Support

**Goal:** Server-side awareness of workspaces. Project alias resolution. Spawn with project context.

### 2.1 Project List RPC

New `OrkaService` method:

```typescript
interface ProjectInfo {
  name: string;
  path: string;
  /** Count of non-archived sessions for this project */
  sessionCount: number;
  /** Count of active (running/queued/preparing) sessions */
  activeCount: number;
}

// OrkaService
listProjects(): Promise<ProjectInfo[]>;
```

Implementation in `LocalClient`:
1. Read `projects.json` for aliases
2. Query `SELECT project_path, COUNT(*) ... FROM sessions WHERE archived_at IS NULL GROUP BY project_path`
3. Merge: alias name wins over path-derived name
4. Include projects from aliases that have 0 sessions (so the user sees registered projects even if idle)

### 2.2 Session List Filtering by Project

Extend `SessionFilters`:

```typescript
interface SessionFilters {
  status?: SessionStatus;
  tag?: string;
  includeArchived?: boolean;
  projectPath?: string;          // ← NEW: filter by exact project path
}
```

Server-side `WHERE project_path = ?` is more efficient than client-side filtering for large session counts.

### 2.3 SpawnRequest Project Path

Currently `SpawnRequest` doesn't carry `projectPath` — it's derived from `cwd` in the CLI. For dashboard spawns:

```typescript
interface SpawnRequest {
  // ... existing fields
  projectPath?: string;  // ← NEW: explicit project context for dashboard spawns
}
```

Daemon behavior:
- If `projectPath` provided → use it as the session's `projectPath` and worktree parent
- If not provided → fall back to current behavior (derive from working directory)

### 2.4 CLI Default Project Detection

Change `orka ps` behavior:

```
orka ps                    → sessions for current project (detect from cwd)
orka ps --all              → all sessions across all projects
orka ps --project <name>   → sessions for named project (existing behavior)
```

Detection: resolve `cwd` → find matching `projectPath` in DB or `projects.json`. If no match, show all (backward compatible).

**Breaking change mitigation:** Add `orka ps --all` first, then after a release, flip the default. Or: only change default when inside a registered project directory.

### 2.5 DB Index

Add index for the new filter:

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
```

This makes `WHERE project_path = ?` fast even with thousands of sessions.

---

## Phase 3: Workspace Stats and Settings

**Goal:** Rich workspace overview with aggregated stats.

### 3.1 Workspace Stats RPC

```typescript
interface WorkspaceStats {
  path: string;
  name: string;
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  failedSessions: number;
  totalCost: number;          // Sum of session costs (from results)
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActivityAt: string;     // Most recent session start/finish
}

// OrkaService
getWorkspaceStats(projectPath: string): Promise<WorkspaceStats>;
```

Cost aggregation: query `orchestration_events` for cost data, grouped by session, filtered by `project_path`.

### 3.2 Dashboard Workspace Overview

When a workspace is selected but no session is active, show a workspace overview instead of the empty state:

```
┌─ Workspace: orka ──────────────────────────┐
│                                            │
│  12 sessions  ·  3 active  ·  $4.82 total  │
│                                            │
│  ┌─ Recent ──────────────────────────────┐ │
│  │ Refactor auth        running    2m    │ │
│  │ Fix relay            completed  5m    │ │
│  │ Add workspace plan   running    1m    │ │
│  └───────────────────────────────────────┘ │
│                                            │
│  ┌─ Stats ───────────────────────────────┐ │
│  │ Completed: 8    Failed: 1             │ │
│  │ Tokens: 1.2M in / 340K out           │ │
│  │ Last activity: 2 minutes ago          │ │
│  └───────────────────────────────────────┘ │
│                                            │
│          [+ New Session]                   │
└────────────────────────────────────────────┘
```

### 3.3 Per-Workspace Config in Dashboard

When spawning within a workspace, load the project's `.orka.toml` defaults:
- Default backend, model, mode, tags, permission mode
- Show these as pre-filled values in `DraftChatView` / `SpawnAdvancedPanel`

Requires a new RPC:

```typescript
// OrkaService
getProjectConfig(projectPath: string): Promise<ResolvedConfig>;
```

The daemon already resolves project config during spawn — this just exposes it for the dashboard to preview.

---

## Data Model Decision: Table vs Derived

**Recommendation: Derive workspaces from sessions, no `workspaces` table.**

Rationale:
- Workspaces are just `GROUP BY project_path` — no unique data to store
- Project aliases already live in `projects.json`
- Stats can be computed on-demand (sessions table is the source of truth)
- Adding a table creates sync burden: what if user spawns from CLI with a new project path? Need to auto-create workspace row, handle name conflicts, etc.
- Keeps the data model simple — one less entity to manage

If we later need per-workspace settings beyond `.orka.toml` (e.g., pinned sessions, custom color), we can add a `workspace_prefs` table then. Not now.

---

## Migration Steps

### Phase 1 (dashboard-only, no backend changes)

1. **Add `workspaceStore.ts`** — `selectedPath`, persistence, URL hash sync
2. **Add `useWorkspaces()` hook** — derive `Workspace[]` from `sessionStore.sessions`
3. **Add workspace pill bar to `Sidebar.tsx`** — between node selector and search
4. **Update filtering pipeline** — add workspace filter step
5. **Update sidebar header** — workspace-aware active/total counts
6. **Update URL hash parsing** in `App.tsx` — `#workspace=<name>`
7. **Mobile:** workspace pills in `MobileSidebarDrawer`
8. **Persist** `selectedPath` to localStorage

**Estimated scope:** ~300 LOC new, ~50 LOC modified. No tests needed (UI-only).

### Phase 2 (API changes)

1. **Add `listProjects()` to `OrkaService`** — interface + LocalClient + RemoteClient
2. **Add `projectPath` to `SessionFilters`** — schema + DB query + RPC
3. **Add `projectPath` to `SpawnRequest`** — schema + daemon spawn logic
4. **Add `idx_sessions_project_path` index** — DB migration
5. **Update `orka ps` default** — detect project from cwd
6. **Dashboard:** use `listProjects()` for workspace names instead of path parsing

**Estimated scope:** ~200 LOC new, ~80 LOC modified. Add tests for `listProjects()` and filter.

### Phase 3 (stats + config)

1. **Add `getWorkspaceStats()` to `OrkaService`**
2. **Add `getProjectConfig()` to `OrkaService`**
3. **Dashboard workspace overview component**
4. **DraftChatView:** pre-fill from project config when workspace selected

**Estimated scope:** ~400 LOC new, ~50 LOC modified.

---

## Open Questions

1. **Group headers vs pills?** Pills are simpler. Group headers give better "All" view. Could do both — pills for filtering, headers within "All" view. Start with pills only.

2. **CLI default change?** Changing `orka ps` to default to current project is a behavior change. Safest: only default-filter when `cwd` is inside a *registered* project (in `projects.json`). Unknown directories → show all.

3. **Dashboard workspace from URL vs detection?** Dashboard doesn't know the user's cwd. Workspace selection is purely manual (pills) or restored from localStorage. No auto-detection needed — the dashboard is a remote UI.

4. **Empty projectPath sessions?** Old sessions or sessions spawned without a project context may have `projectPath = ""`. Group these as "Ungrouped" or "Other". Don't hide them.

5. **Workspace name collisions?** Two projects named "api" at different paths. Use alias if registered, else disambiguate: "api (~/prj/)" vs "api (~/work/)". Or just show last two path components.
