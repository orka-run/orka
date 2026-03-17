# Workspaces Entity Analysis — Three Approaches Compared

## Context

The current [workspaces plan](workspaces-plan.md) says: "No workspaces table — derive from sessions.projectPath + projects.json aliases." This document challenges that decision and compares three approaches.

### Current State (What We Have)

| Component | State |
|---|---|
| `session.workspace_id` | **Vestigial.** Generated per session (`ws-*`), stored in DB, never queried, never exposed in API responses. Dead column. |
| `session.project_path` | Absolute path string. No DB index. Filtering happens in app layer after full fetch. |
| `projects.json` | Flat JSON array of `{name, path}` aliases. No DB persistence. Local to each machine. |
| Dashboard | Flat session list. No project grouping. `SessionSummary.projectPath` available but unused for UX. |
| Config | Per-project `.orka.toml` merged over `~/.orka/config.toml`. File-based, no DB representation. |

### The Core Question

Should "workspace" be a first-class database entity, or a derived concept?

---

## Arguments FOR a Workspace Entity

### 1. Workspace Settings Beyond `.orka.toml`

Per-project defaults (backend, model, permissionMode, system prompt) currently live in `.orka.toml` files in project roots. This works for local CLI usage but breaks for:
- **Remote workspaces**: When connecting to a remote node via relay, the client machine doesn't have the project directory. Where do settings live?
- **Dashboard-only settings**: UI preferences like pinned sessions, custom colors, notification rules — no `.toml` file to store these in.
- **Settings without a filesystem**: Workspace-level approval rules, cost budgets, notification preferences have no natural home in a dotfile.

### 2. Workspace Metadata

A derived concept can't carry metadata. You can't attach a custom name, description, icon/color, or "pinned" status to a `GROUP BY project_path` result. The plan acknowledges this gap: workspace names fall back to `path.basename()` or alias lookup.

### 3. Multi-Project Workspaces

The derived model assumes workspace = single project path. But real use cases break this:
- A monorepo with `packages/api/`, `packages/web/`, `packages/shared/` — three "projects" but one logical workspace.
- An infra workspace spanning `terraform/`, `k8s-configs/`, `monitoring/` — different repos, one concern.
- A "frontend" workspace grouping `web-app/`, `mobile-app/`, `design-tokens/`.

With derivation from `project_path`, these are forever separate.

### 4. Workspace Lifecycle

You can't archive, delete, or temporarily hide a derived concept. If a project is decommissioned but has 200 historical sessions, it shows up in the workspace list forever. An entity can be `archived_at IS NOT NULL`.

### 5. Remote Workspaces

In multi-machine mode, `project_path` is a local filesystem path on the node. When a client connects via relay to `node-gpu-1`, the path `/home/user/ml-training` is meaningless to the client. The workspace is the logical grouping that spans machines — same "ml-training" workspace, different node paths.

### 6. The `workspace_id` Column Already Exists

Sessions already have a `workspace_id` column (vestigial, but present). The migration cost to repurpose it is lower than adding a new FK. We just need to give it a real referent.

### 7. Future Features That Need an Entity

- Workspace-level cost budgets and alerts
- Workspace-level system prompt (prepended to all sessions)
- Workspace-level shared context / knowledge base
- Workspace-level access control (multi-user)
- Workspace-level hooks (beyond what `.orka.toml` can do)

Each of these needs a row to attach data to. Without an entity, they become ad-hoc JSON blobs scattered across config files.

---

## Arguments AGAINST (Why Derivation Could Work)

1. **Small count, no complex queries** — Most users have <10 projects. `GROUP BY project_path` is fast.
2. **Sync burden** — CLI spawn with unknown path must auto-create workspace row. What name? What settings? Implicit entity creation is a source of bugs.
3. **YAGNI** — Most "future features" listed above don't exist yet. Building the entity before the features inverts the dependency.
4. **Two sources of truth** — `.orka.toml` and a workspace row both claim to hold project settings. Which wins?
5. **Migration complexity** — Existing sessions have arbitrary `project_path` values. Grouping them into workspace rows requires deduplication logic.

---

## Approach A: No Entity (Current Plan)

### Data Model

No schema changes. Workspaces derived client-side from `sessions.project_path`.

```
┌─────────────┐       ┌──────────────┐
│   sessions   │──FK──▶│    tasks      │
│              │       └──────────────┘
│ project_path │  (string, no FK, no index)
│ workspace_id │  (vestigial, ignored)
└──────────────┘

projects.json: [{name: "orka", path: "/home/user/prj/orka"}, ...]
```

### Dashboard UX

```
┌─ Sidebar ─────────────────────────────────────────┐
│ orka │ 4 active / 12 total │ [+New] [⚙]          │
├───────────────────────────────────────────────────┤
│ [All ▾] [orka (3)] [frontend (1)] [api]           │  ← derived from projectPath
├───────────────────────────────────────────────────┤
│ [🔍 Search sessions                          ]    │
├───────────────────────────────────────────────────┤
│ • Refactor auth middleware      running    2m ago  │
│ • Fix relay reconnect           done       5m ago  │
│ • Add workspace plan            running    1m ago  │
└───────────────────────────────────────────────────┘

Workspace pills show: basename(projectPath) or alias name
No workspace detail view — selecting a workspace just filters sessions
No workspace settings in dashboard
```

### CLI Commands

No new commands. Existing `orka project add/remove/list` manages aliases. `orka ps --project <ref>` filters.

### API Changes

```typescript
// New method for dashboard alias resolution
listProjects(): Promise<ProjectInfo[]>;

// Extend filters
interface SessionFilters {
  projectPath?: string;  // server-side WHERE clause
}
```

### Migration Path

1. Add `idx_sessions_project_path` index
2. Add `listProjects()` RPC
3. Dashboard derives workspaces from session list
4. Drop vestigial `workspace_id` column (cleanup)

### Effort Estimate

~500 LOC across 3 phases (see workspaces-plan.md). Mostly dashboard UI.

### What It Enables

- Session grouping by project in dashboard
- Server-side project filtering
- Project alias resolution in dashboard
- Workspace stats computed on-demand

### What It Cannot Do

- Custom workspace names/metadata (beyond aliases)
- Multi-project workspaces
- Remote workspace identity
- Workspace-level settings in dashboard
- Workspace archival/lifecycle
- Workspace-level cost budgets
- Per-workspace system prompts or hooks

---

## Approach B: Lightweight Entity

### Data Model

```sql
-- New table
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,          -- 'ws-' prefixed nanoid
  name TEXT NOT NULL,           -- display name (editable)
  created_at TEXT NOT NULL,
  archived_at TEXT,             -- soft delete
  settings TEXT,                -- JSON: defaults, overrides
  metadata TEXT                 -- JSON: color, icon, description, pinned
);

-- Junction table: workspace ↔ project paths (1:N)
CREATE TABLE workspace_paths (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_path TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_path)
);
CREATE INDEX idx_workspace_paths_path ON workspace_paths(project_path);

-- Repurpose existing column (workspace_id already exists on sessions)
-- Just needs: UPDATE sessions SET workspace_id = <resolved-ws> WHERE ...
-- Add FK constraint in migration:
CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
```

**Workspace settings JSON schema:**

```typescript
interface WorkspaceSettings {
  defaults?: {
    backend?: string;
    model?: string;
    permissionMode?: string;
    systemPrompt?: string;
    tags?: string[];
  };
  // Future: budgets, approval rules, hooks
}

interface WorkspaceMetadata {
  color?: string;       // hex or preset name
  icon?: string;        // emoji or icon key
  description?: string;
  pinned?: boolean;
}
```

**Resolution order for spawn defaults:**
1. CLI flags (highest priority)
2. `.orka.toml` in project root
3. Workspace settings (DB)
4. `~/.orka/config.toml` (global)

### Dashboard UX

```
┌─ Sidebar ─────────────────────────────────────────┐
│ orka │ 4 active / 12 total │ [+New] [⚙]          │
├───────────────────────────────────────────────────┤
│ [All ▾] [🟢 orka (3)] [🔵 frontend (1)] [api]    │  ← workspace entity w/ color
├───────────────────────────────────────────────────┤
│ [🔍 Search sessions                          ]    │
├───────────────────────────────────────────────────┤
│ • Refactor auth middleware      running    2m ago  │
│ • Fix relay reconnect           done       5m ago  │
│ • Add workspace plan            running    1m ago  │
└───────────────────────────────────────────────────┘

┌─ Workspace Detail (when workspace selected, no session) ──┐
│                                                            │
│  🟢 orka                                    [⚙ Settings]  │
│  Agent session orchestrator                                │
│                                                            │
│  12 sessions · 3 active · $4.82 total                      │
│  Projects: /home/user/prj/orka                             │
│                                                            │
│  ┌─ Defaults ────────────────────────────────────┐         │
│  │ Backend: claude-code    Model: opus           │         │
│  │ Permission: supervised  Tags: [infra]         │         │
│  └───────────────────────────────────────────────┘         │
│                                                            │
│  ┌─ Recent ──────────────────────────────────────┐         │
│  │ Refactor auth           running       2m ago  │         │
│  │ Fix relay               completed     5m ago  │         │
│  │ Add workspace plan      running       1m ago  │         │
│  └───────────────────────────────────────────────┘         │
│                                                            │
│           [+ New Session]                                  │
└────────────────────────────────────────────────────────────┘

┌─ Workspace Settings Modal ────────────────────────┐
│                                                    │
│  Name: [orka                              ]        │
│  Color: [🟢 ▾]    Icon: [🔧]                      │
│  Description: [Agent session orchestrator ]        │
│                                                    │
│  ── Defaults ──                                    │
│  Backend:    [claude-code ▾]                       │
│  Model:      [opus         ]                       │
│  Permission: [supervised  ▾]                       │
│  System prompt: [                         ]        │
│  Tags:       [infra] [+]                           │
│                                                    │
│  ── Projects ──                                    │
│  /home/user/prj/orka                    [✕]        │
│  [+ Add project path]                              │
│                                                    │
│  [Archive Workspace]           [Save] [Cancel]     │
└────────────────────────────────────────────────────┘
```

### CLI Commands

```
orka workspace list                    List workspaces
orka workspace create <name> [path]    Create workspace (auto-links current dir if no path)
orka workspace config <name>           Show/edit workspace settings
orka workspace archive <name>          Archive workspace (hide from default views)
orka workspace add-path <name> <path>  Add project path to workspace
orka workspace rm-path <name> <path>   Remove project path from workspace
```

### API Changes

```typescript
// New types
interface WorkspaceInfo {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  settings: WorkspaceSettings | null;
  metadata: WorkspaceMetadata | null;
  paths: string[];
  sessionCount: number;
  activeCount: number;
}

interface WorkspaceStats {
  id: string;
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  failedSessions: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActivityAt: string | null;
}

// New OrkaService methods
listWorkspaces(opts?: { includeArchived?: boolean }): Promise<WorkspaceInfo[]>;
getWorkspace(id: string): Promise<WorkspaceInfo>;
createWorkspace(opts: { name: string; paths?: string[]; settings?: WorkspaceSettings; metadata?: WorkspaceMetadata }): Promise<WorkspaceInfo>;
updateWorkspace(id: string, opts: Partial<{ name: string; settings: WorkspaceSettings; metadata: WorkspaceMetadata; archivedAt: string | null }>): Promise<void>;
getWorkspaceStats(id: string): Promise<WorkspaceStats>;

// Extended session filters
interface SessionFilters {
  workspaceId?: string;  // filter by workspace
  projectPath?: string;  // filter by exact path (still useful)
}
```

### Auto-Creation Logic

When `orka spawn` runs for a `project_path` not linked to any workspace:
1. Look up `workspace_paths` for the path → return workspace if found
2. Look up `projects.json` for an alias → use alias name if found
3. Auto-create workspace with `name = basename(path)`, link the path
4. Assign `workspace_id` to the new session

This ensures every session gets a workspace without manual setup. Users can rename/customize later.

### Migration Path

1. Create `workspaces` and `workspace_paths` tables
2. Backfill: `SELECT DISTINCT project_path FROM sessions` → create workspace per unique path, link paths, update `workspace_id`
3. Add `idx_sessions_workspace_id` index
4. Add OrkaService methods + RPC handlers
5. CLI: add `orka workspace` subcommands
6. Dashboard: switch from derived workspaces to API-backed workspaces

**Backfill migration (pseudocode):**

```typescript
// In db.ts migration
const paths = db.query("SELECT DISTINCT project_path FROM sessions WHERE project_path != ''").all();
for (const { project_path } of paths) {
  const wsId = generateId("ws");
  const name = basename(project_path);
  db.exec(`INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)`, [wsId, name, now()]);
  db.exec(`INSERT INTO workspace_paths (workspace_id, project_path) VALUES (?, ?)`, [wsId, project_path]);
  db.exec(`UPDATE sessions SET workspace_id = ? WHERE project_path = ?`, [wsId, project_path]);
}
```

### Effort Estimate

- DB schema + migration + backfill: ~150 LOC
- Workspace CRUD in LocalClient: ~200 LOC
- RPC handlers + RemoteClient: ~100 LOC
- CLI `orka workspace` subcommands: ~150 LOC
- Dashboard workspace store + UI: ~400 LOC
- Auto-creation in spawn path: ~50 LOC
- **Total: ~1050 LOC**

### What It Enables (Beyond Approach A)

- Custom workspace names, colors, icons, descriptions
- Multi-project workspaces (multiple paths per workspace)
- Workspace archival (hide old projects)
- Workspace-level defaults (backend, model, systemPrompt) stored in DB
- Dashboard workspace settings panel
- Foundation for remote workspace identity
- Foundation for workspace-level budgets, hooks, access control

### What It Cannot Do (Deferred to Approach C)

- Workspace-level system prompt injection
- Workspace-level cost budgets with enforcement
- Workspace-level hooks with daemon execution
- Workspace-level shared context / knowledge base
- Workspace-level access control

---

## Approach C: Full Entity with Workspace-Level Features

### Data Model

Everything from Approach B, plus:

```sql
-- Extend workspaces table
ALTER TABLE workspaces ADD COLUMN system_prompt TEXT;
ALTER TABLE workspaces ADD COLUMN budget_cents INTEGER;        -- monthly cost cap, null = unlimited
ALTER TABLE workspaces ADD COLUMN budget_reset_at TEXT;        -- next budget reset timestamp
ALTER TABLE workspaces ADD COLUMN hooks TEXT;                  -- JSON: workspace-level hooks
ALTER TABLE workspaces ADD COLUMN context TEXT;                -- JSON: shared knowledge entries

-- Workspace members (multi-user future)
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member' | 'viewer'
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Workspace cost tracking (materialized, not computed)
CREATE TABLE workspace_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period TEXT NOT NULL,           -- '2026-03' (monthly bucket)
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, period)
);
```

**Full settings schema:**

```typescript
interface WorkspaceSettings {
  defaults?: {
    backend?: string;
    model?: string;
    permissionMode?: string;
    systemPrompt?: string;
    tags?: string[];
  };
  budget?: {
    monthlyCents?: number;       // null = unlimited
    alertThresholdPct?: number;  // e.g. 80 = alert at 80% usage
  };
  hooks?: {
    beforeSpawn?: string[];      // shell commands to run before spawn
    afterComplete?: string[];    // shell commands to run after session completes
  };
  approval?: {
    requireApproval?: boolean;   // all sessions need approval before starting
    autoApproveBackends?: string[];
  };
}

interface WorkspaceContext {
  entries: Array<{
    key: string;
    value: string;
    updatedAt: string;
  }>;
}
```

### Dashboard UX

Everything from Approach B, plus:

```
┌─ Workspace Detail (enhanced) ─────────────────────┐
│                                                    │
│  🟢 orka                          [⚙ Settings]    │
│  Agent session orchestrator                        │
│                                                    │
│  12 sessions · 3 active · $4.82 / $50.00 budget   │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░  9.6%           │
│  Projects: /home/user/prj/orka                     │
│                                                    │
│  ┌─ System Prompt ───────────────────────────┐     │
│  │ You are working on the Orka project.      │     │
│  │ Always run tests before committing.       │     │
│  │                                    [Edit] │     │
│  └───────────────────────────────────────────┘     │
│                                                    │
│  ┌─ Shared Context (3 entries) ──────────────┐     │
│  │ arch-decisions: "We use Bun, not Node..." │     │
│  │ api-conventions: "All endpoints return.." │     │
│  │ deployment: "Push to main triggers..."    │     │
│  │                              [Manage ▸]   │     │
│  └───────────────────────────────────────────┘     │
│                                                    │
│  ┌─ Members ─────────────────────────────────┐     │
│  │ ilya@example.com          owner           │     │
│  │ alice@example.com         member          │     │
│  │                              [Manage ▸]   │     │
│  └───────────────────────────────────────────┘     │
│                                                    │
│  ┌─ Recent ──────────────────────────────────┐     │
│  │ Refactor auth        running      2m ago  │     │
│  │ Fix relay            completed    5m ago  │     │
│  │ Add workspace plan   running      1m ago  │     │
│  └───────────────────────────────────────────┘     │
│                                                    │
│           [+ New Session]                          │
└────────────────────────────────────────────────────┘
```

### CLI Commands

Everything from Approach B, plus:

```
orka workspace budget <name> [amount]     Set/view monthly budget
orka workspace prompt <name> [text]       Set/view workspace system prompt
orka workspace context <name> list        List shared context entries
orka workspace context <name> set <k> <v> Set context entry
orka workspace context <name> rm <k>      Remove context entry
orka workspace members <name>             List workspace members
orka workspace invite <name> <email>      Invite member (future)
```

### API Changes

Everything from Approach B, plus:

```typescript
// Extended workspace info
interface WorkspaceInfo {
  // ... all from Approach B
  systemPrompt: string | null;
  budget: { monthlyCents: number | null; usedCents: number; alertThresholdPct: number | null } | null;
  hooks: WorkspaceHooks | null;
  contextEntryCount: number;
  memberCount: number;
}

// New methods
setWorkspaceSystemPrompt(id: string, prompt: string | null): Promise<void>;
setWorkspaceBudget(id: string, monthlyCents: number | null): Promise<void>;
getWorkspaceUsage(id: string, period?: string): Promise<WorkspaceUsage>;
listWorkspaceContext(id: string): Promise<WorkspaceContextEntry[]>;
setWorkspaceContext(id: string, key: string, value: string): Promise<void>;
deleteWorkspaceContext(id: string, key: string): Promise<void>;
```

**System prompt injection during spawn:**

```typescript
// In orchestrator.ts, during session preparation:
const workspace = await getWorkspaceForPath(session.projectPath);
if (workspace?.systemPrompt) {
  session.systemPrompt = workspace.systemPrompt + "\n\n" + (session.systemPrompt ?? "");
}
```

**Budget enforcement during spawn:**

```typescript
const usage = await getWorkspaceUsage(workspace.id, currentPeriod());
if (workspace.budgetCents && usage.totalCostCents >= workspace.budgetCents) {
  throw new BudgetExceededError(workspace.name, usage.totalCostCents, workspace.budgetCents);
}
```

### Migration Path

1. Everything from Approach B
2. Add columns to workspaces: `system_prompt`, `budget_cents`, `budget_reset_at`, `hooks`, `context`
3. Create `workspace_usage` table
4. Create `workspace_members` table
5. Add usage tracking to session completion handler (increment `workspace_usage` on session finish)
6. Add budget check to spawn path
7. Add system prompt injection to orchestrator

### Effort Estimate

- Everything from Approach B: ~1050 LOC
- Budget tracking + enforcement: ~200 LOC
- System prompt injection: ~50 LOC
- Workspace context CRUD: ~150 LOC
- workspace_usage materialization: ~100 LOC
- workspace_members (stub, no auth yet): ~100 LOC
- Dashboard budget/prompt/context UI: ~500 LOC
- CLI workspace subcommands (budget, prompt, context): ~200 LOC
- **Total: ~2350 LOC**

### What It Enables (Beyond Approach B)

- Workspace-level system prompt prepended to all sessions
- Monthly cost budgets with enforcement and alerts
- Shared context entries (key-value knowledge base for sessions)
- Workspace-level hooks (before-spawn, after-complete)
- Member management foundation (for future multi-user)
- Pre-spawn approval rules per workspace
- Usage tracking with historical periods

### What It Cannot Do

- Real multi-user auth (needs relay-level user identity)
- Cross-node workspace sync (needs relay-level workspace awareness)
- Workspace templates (create workspace from preset)

---

## Comparison Matrix

| Capability | A: Derived | B: Lightweight | C: Full |
|---|:---:|:---:|:---:|
| Session grouping in dashboard | ✅ | ✅ | ✅ |
| Server-side project filtering | ✅ | ✅ | ✅ |
| Project alias resolution | ✅ | ✅ | ✅ |
| Workspace stats (on-demand) | ✅ | ✅ | ✅ |
| Custom name / color / icon | ❌ | ✅ | ✅ |
| Multi-project workspaces | ❌ | ✅ | ✅ |
| Workspace archival | ❌ | ✅ | ✅ |
| Workspace-level defaults (DB) | ❌ | ✅ | ✅ |
| Remote workspace identity | ❌ | ✅ | ✅ |
| Workspace system prompt | ❌ | ❌ | ✅ |
| Cost budgets + enforcement | ❌ | ❌ | ✅ |
| Shared context / knowledge base | ❌ | ❌ | ✅ |
| Workspace hooks | ❌ | ❌ | ✅ |
| Member management | ❌ | ❌ | ✅ (stub) |
| Schema changes | index only | 2 tables + backfill | 4 tables + backfill |
| Effort | ~500 LOC | ~1050 LOC | ~2350 LOC |
| Sync complexity | none | auto-create on spawn | auto-create + usage tracking |

---

## Recommendation

**Start with Approach B.** Here's why:

### Why Not A

Approach A is the "cheapest" path but creates a ceiling. The moment you need workspace metadata, multi-project grouping, or remote workspace identity, you need to retrofit an entity anyway. The current plan's "add `workspace_prefs` table later" escape hatch is just Approach B deferred — with the added cost of a second migration and data model change after users have already internalized the derived model.

### Why Not C (Yet)

Approach C front-loads features (budgets, context, hooks, members) before the entity itself is battle-tested. System prompt injection and budget enforcement add spawn-path complexity that should come after the basic workspace model is solid. These features are additive — they're column additions and new tables, not schema redesigns. Building them on top of B is straightforward.

### Why B

1. **Repurpose `workspace_id`**: The column already exists on every session. Making it meaningful costs one backfill migration, not a schema addition.
2. **Auto-creation eliminates sync burden**: CLI users never manually create workspaces. `orka spawn` in a new directory auto-creates one. Zero friction.
3. **Multi-project is the key differentiator**: The junction table (`workspace_paths`) is the one thing you can't retrofit onto a derived model without an entity. It's also the feature most relevant to real usage — monorepos, related services, infrastructure-as-code.
4. **Settings in DB solve the remote problem**: When a client connects via relay, workspace settings travel over the wire. No `.orka.toml` needed on the client machine.
5. **~1050 LOC is modest**: For a foundation that supports the next 3 features (budgets, prompts, context) without schema redesign, this is reasonable.
6. **Clean migration from current state**: The vestigial `workspace_id` becomes the FK. Existing sessions get backfilled. No column removal or rename needed.

### Implementation Order

1. **DB schema + backfill migration** — workspaces table, workspace_paths, backfill from distinct project_paths
2. **Auto-creation in spawn path** — resolve path → workspace, create if missing
3. **OrkaService CRUD** — listWorkspaces, getWorkspace, createWorkspace, updateWorkspace
4. **CLI `orka workspace` subcommands** — list, create, config, archive, add-path, rm-path
5. **Dashboard workspace store** — switch from derived to API-backed
6. **Dashboard workspace detail view** — settings panel, stats, metadata editor
7. **Later (Approach C features)**: system prompt, budgets, context, hooks — each as standalone additions

### Config Precedence (Two Sources of Truth Problem)

The concern about `.orka.toml` vs workspace settings having two sources of truth is valid. Resolution:

- `.orka.toml` remains the **developer-facing, version-controlled** config (checked into the repo)
- Workspace settings are the **operator-facing, dashboard-managed** config (in the DB)
- Merge order: CLI flags > `.orka.toml` > workspace settings > `~/.orka/config.toml`
- `.orka.toml` wins over workspace DB settings because it's closer to the code and version-controlled

This mirrors how many tools work: `pyproject.toml` (repo) vs dashboard settings (platform).

### What About `projects.json`?

With workspaces as entities, `projects.json` becomes redundant:
- Project aliases → workspace names
- Project paths → workspace_paths table
- `orka project add/remove` → `orka workspace create/add-path`

Migration: import existing aliases as workspaces during the backfill, then deprecate `projects.json` and `orka project` commands. Since there's no backward compatibility requirement (per CLAUDE.md), just remove them.
