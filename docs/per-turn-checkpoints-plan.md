# Per-Turn Git Checkpoints — Design Plan

## Goal

Capture a git snapshot at the end of each agent turn so the dashboard can show what changed per turn and (optionally) allow reverting to any previous turn's state.

## Prior Art: t3code

t3code implements checkpoints using an **isolated git index** approach:

1. Create a temp directory with a unique `GIT_INDEX_FILE`
2. `git read-tree HEAD` into that temp index
3. `git add -A -- .` (stages all changes, respects `.gitignore`)
4. `git write-tree` → tree OID
5. `git commit-tree <tree> -m "checkpoint turn=N"` → commit OID
6. `git update-ref refs/t3/checkpoints/<thread>/<turn> <commit>` → hidden ref
7. Clean up temp index

They store metadata in both git refs (the actual snapshots) and a SQLite projection table (turn count, status, file changes, timestamps). Revert is `git restore --source <commit> --worktree --staged -- .` + `git clean -fd`.

Key insight: the temp index means the agent's actual staging area is never touched — the checkpoint is invisible to the running agent.

## Approach Comparison

| Approach | Complexity | Junk Safety | Revert | Storage Cost | New File Support | Agent Interference |
|----------|-----------|-------------|--------|-------------|------------------|--------------------|
| **A: Full snapshot (t3code)** | Medium | Relies on .gitignore | Full | Medium (git objects) | Yes | None (isolated index) |
| **B: Tracked files only** | Low | Safe | Full | Low | **No** — misses new files | None |
| **C: Diff-based (SQLite)** | Low | Safe (diff of tracked) | None | Variable (diffs can be huge) | Partial | None |
| **D: Agent commits only** | Zero | Perfect (agent chose what to commit) | Full (just checkout) | Zero overhead | Yes | None |
| **E: Hybrid (commits + diff)** | Medium | Good | Partial | Low-medium | Yes | None |
| **F: git stash create** | Low | Relies on .gitignore | Full | Medium | Yes | None |

## Recommended Approach: A (isolated-index snapshot, t3code style)

### Rationale

**Why not D (agent commits)?** It's the most natural checkpoint, but unreliable. Claude Code auto-commits but not necessarily at turn boundaries. Codex doesn't auto-commit at all. We can't guarantee a commit exists for every turn, so we'd have gaps in the timeline.

**Why not E (hybrid)?** Adds complexity for marginal benefit. If we're already capturing diffs for uncommitted changes, we might as well capture the full tree — the cost difference is negligible.

**Why not C (diff-only)?** No revert capability. Diffs can be enormous for binary files or large generated files. And reconstructing state from a chain of diffs is fragile.

**Why not B (tracked only)?** Misses new files the agent created, which are often the entire point of the turn (e.g., "create a new component").

**Why not F (stash create)?** `git stash create` is close, but it creates merge-commit-style objects that are harder to diff cleanly, and it includes the index state which may be polluted by agent operations.

**Why A?** It captures exactly what `.gitignore` allows — the same set of files that would show up in `git status`. The isolated index means zero interference with the running agent. The resulting commit objects are normal git objects that support `git diff`, `git log`, `git restore`, and all standard tooling. t3code has proven this works at scale.

### The "junk in worktree" problem

`git add -A` respects `.gitignore`, which handles the majority of cases (node_modules, build artifacts, .env). For edge cases:

1. **Orka's worktrees are fresh clones** — they start from a clean branch, so there's no pre-existing junk.
2. **Agent-created temp files** that aren't gitignored are legitimate working state — capturing them is arguably correct. If the agent downloads a large file and doesn't gitignore it, that's the agent's problem.
3. **We add a size guard**: if `git write-tree` produces a tree where the diff from the previous checkpoint exceeds a configurable threshold (default: 10 MB), we store only the diff stat (file names + sizes) and skip the commit object. This prevents a single rogue turn from bloating the repo.
4. **We maintain an orka-specific exclude file** at `~/.orka/checkpoint-exclude` (or `.orka/.gitignore` in the worktree) that users can customize. Passed via `git -c core.excludesFile=...`.

## Implementation Plan

### 1. Database Schema

New migration (version 32):

```sql
CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,        -- sequential turn number within session
  commit_oid TEXT,                   -- git commit SHA (null if skipped due to size)
  ref_name TEXT,                     -- e.g. refs/orka/checkpoints/<session-id>/<turn-seq>
  parent_commit_oid TEXT,            -- previous checkpoint commit (null for first)
  files_changed INTEGER DEFAULT 0,
  insertions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  diff_stat TEXT,                    -- JSON: [{path, insertions, deletions, status}]
  skipped_reason TEXT,               -- null if captured, otherwise "size_exceeded", "no_changes", "git_error"
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_checkpoints_session ON checkpoints(session_id, turn_seq);
```

### 2. Git Operations Module

New file: `packages/daemon/src/checkpoint.ts`

```
captureCheckpoint(opts: {
  workingDir: string;
  sessionId: string;
  turnId: string;
  turnSeq: number;
  parentCommitOid?: string;
  excludesFile?: string;
  maxDiffBytes?: number;
}) → Promise<CheckpointResult>
```

**CheckpointResult:**
```typescript
type CheckpointResult =
  | { status: "captured"; commitOid: string; refName: string; diffStat: DiffStatEntry[]; filesChanged: number; insertions: number; deletions: number }
  | { status: "no_changes" }
  | { status: "size_exceeded"; diffStat: DiffStatEntry[] }
  | { status: "error"; error: string }
```

**Implementation steps:**
1. Create temp dir for isolated index
2. Set `GIT_INDEX_FILE` to temp path
3. If `parentCommitOid` exists, `git read-tree <parent>` into temp index; otherwise `git read-tree HEAD`
4. `git add -A -- .` with the temp index (plus optional `core.excludesFile`)
5. `git write-tree` → tree OID
6. **Size check**: `git diff-tree --stat <parent-tree> <new-tree>` — if total diff exceeds threshold, return `size_exceeded` with stat only
7. `git commit-tree <tree> -p <parent> -m "orka checkpoint session=<id> turn=<seq>"` with hardcoded author (Orka Checkpoint / noreply)
8. `git update-ref refs/orka/checkpoints/<session-id>/<turn-seq> <commit>`
9. Compute diff stat: `git diff-tree --numstat <parent> <commit>` → parse into `DiffStatEntry[]`
10. Clean up temp dir
11. Return `CheckpointResult`

### 3. Hook Point: Consumer Turn Completion

**Location:** `packages/daemon/src/orchestration/consumer.ts`, inside `handleTurnCompleted()`

Add checkpoint capture **before** the idle transition, as a fire-and-forget async operation that doesn't block the turn completion flow:

```
async function handleTurnCompleted(sessionId, callbacks):
  // 1. Capture checkpoint (non-blocking — errors logged, not thrown)
  if (callbacks.captureCheckpoint) {
    captureCheckpointSafe(sessionId, callbacks).catch(err =>
      log.warn("checkpoint capture failed", { sessionId, err })
    );
  }

  // 2. Existing: transition to idle
  callbacks.updateSessionStatus(sessionId, "idle");
  ...
```

**Why non-blocking?** Checkpoint capture involves git operations that may take 100ms–1s. Blocking the turn completion would delay the idle transition and hibernate timer. The checkpoint is an observability feature, not a correctness requirement.

**New callback field on `ProviderEventConsumerCallbacks`:**
```typescript
captureCheckpoint?: (sessionId: string, turnId: string) => Promise<void>;
```

Wired from `DaemonContext` through the orchestrator to the consumer callbacks, following the existing DI pattern.

### 4. Turn Sequence Tracking

We need a monotonically increasing turn counter per session. Options:

- **Query DB**: `SELECT MAX(turn_seq) FROM checkpoints WHERE session_id = ?` then increment. Simple, correct.
- **In-memory counter on orchestration engine**: faster but must survive reconnects.

Recommendation: **query DB** — checkpoints are infrequent (once per turn) so the query cost is negligible. This also handles daemon restart correctly.

### 5. Baseline Checkpoint (Turn 0)

Capture a "turn 0" checkpoint when the session starts (after worktree creation, before the agent runs). This gives us a clean baseline to diff against for the first real turn.

**Hook point:** After `runPostCreateHook()` in worktree.ts, or as the first action in the orchestration consumer when `session.started` fires.

Recommendation: capture on `session.started` event in the consumer — this keeps all checkpoint logic in one place.

### 6. RPC Endpoints

Add to `OrkaService` interface:

```typescript
/** List checkpoints for a session, ordered by turn_seq */
getCheckpoints(sessionId: string): Promise<Checkpoint[]>;

/** Get the diff between two checkpoints (or between a checkpoint and its parent) */
getCheckpointDiff(sessionId: string, turnSeq: number, baseTurnSeq?: number): Promise<string>;

/** Revert session worktree to a checkpoint */
revertToCheckpoint(sessionId: string, turnSeq: number): Promise<void>;
```

**getCheckpoints** — simple DB query, returns checkpoint metadata for the dashboard timeline.

**getCheckpointDiff** — runs `git diff <base-commit> <target-commit>` in the worktree. If `baseTurnSeq` is omitted, diffs against the checkpoint's parent.

**revertToCheckpoint** — described below.

### 7. Revert Flow

Reverting is a destructive operation that restores the worktree to a checkpoint's state:

1. Validate: session must be idle or hibernated (not running)
2. Look up checkpoint commit OID from DB
3. In the worktree directory:
   - `git restore --source <commit> --worktree --staged -- .`
   - `git clean -fd -- .` (remove files not in checkpoint)
   - `git reset --quiet -- .` (unstage everything — leave as working tree changes)
4. Delete checkpoint rows for turns > target turn_seq
5. Delete git refs for turns > target turn_seq: `git update-ref -d <ref>`
6. Broadcast `orchestration.checkpointReverted` via PushHub
7. If session is hibernated, it can be resumed from this state

**Important:** revert does NOT rewind the agent's conversation history. The agent (if resumed) will continue from its last message, but the filesystem will be at the reverted state. This is intentional — the user may want to manually fix something and then resume.

## Edge Cases

### Agent commits during a turn

Not a problem. The checkpoint captures the full working tree state at turn boundary, regardless of what commits the agent made. The checkpoint commit is on a separate ref namespace (`refs/orka/checkpoints/`), completely independent of the branch's commit history.

If the agent committed mid-turn, the checkpoint will capture the post-commit state (clean tree or with additional uncommitted changes). The diff between checkpoints will show the net change across the turn, which is what we want.

### Binary files

`git add -A` handles binary files natively. `git diff-tree --numstat` reports binary files as `- - <path>` (dashes for insertions/deletions). We store these in diff_stat as `{path, binary: true}`.

For the dashboard diff view, binary files show as "Binary file changed" — no inline diff. This matches standard git behavior.

### Very large diffs

Handled by the size guard (step 6 in git operations). If the diff exceeds `maxDiffBytes` (default 10 MB), we:
- Still record the checkpoint row with `skipped_reason = "size_exceeded"`
- Store the diff stat (which files changed and how much) but not the commit object
- The dashboard shows "Checkpoint too large to capture" with the file list

For the `getCheckpointDiff` RPC, if the checkpoint was skipped, return an error indicating no diff is available.

### Multiple turns in quick succession

Each checkpoint runs independently with its own temp index. Since we use `fire-and-forget` async, two checkpoint captures could theoretically overlap. This is safe because:
- Each uses a unique temp index file path
- Git ref updates are atomic
- DB inserts use sequential turn_seq from MAX query (protected by SQLite's serialized writes with `busy_timeout`)

However, if turn N+1 completes before turn N's checkpoint finishes, the turn N+1 checkpoint would use the wrong parent. Fix: **serialize checkpoint captures per session** using a simple per-session mutex (Map<sessionId, Promise>). Chain each capture after the previous one.

### Session with no changes in a turn

After `git add -A` + `git write-tree`, compare the new tree OID with the parent's tree OID. If identical, skip the commit and record `skipped_reason = "no_changes"`. This is cheap (just an OID comparison) and avoids cluttering the ref namespace.

### Worktree already deleted

If the session's worktree has been cleaned up (completed + pruned), checkpoint data still exists in SQLite and git objects still exist in the main repo's object store (refs keep them alive). Diffs can still be computed from the commit objects. Revert is not possible (return error).

### Daemon restart mid-capture

The capture is not transactional across git + SQLite. If the daemon crashes after creating the git ref but before the DB insert, we have an orphaned ref. This is harmless — orphaned refs waste trivial disk space and can be cleaned up by a periodic `gc` task that cross-references refs against the checkpoints table.

## Ref Cleanup

Checkpoint refs accumulate over time. Cleanup strategy:

- When a session is pruned (`orka prune`), delete all its checkpoint refs: `git update-ref -d refs/orka/checkpoints/<session-id>/*`
- Add this to the existing `pruneSession()` flow in db.ts / worktree.ts
- The DB rows cascade-delete via `ON DELETE CASCADE` on session_id FK

## What We Are NOT Building (Yet)

- **Dashboard UI for checkpoints** — this plan covers the backend only. Dashboard integration is a separate task.
- **Checkpoint-based session forking** — reverting + spawning a new session from a checkpoint. Possible future extension.
- **Cross-session checkpoint comparison** — comparing checkpoints between sessions (e.g., "what did session A change vs session B"). Low priority.
- **Automatic .gitignore generation** — we rely on the project's existing .gitignore. If it's missing patterns, that's the project's problem.

## Task Breakdown

1. **DB migration** — Add `checkpoints` table (migration v32)
2. **checkpoint.ts module** — Implement `captureCheckpoint()` with isolated git index
3. **Consumer integration** — Add `captureCheckpoint` callback, wire through DaemonContext, call on `turn.completed` and `session.started` (baseline)
4. **Per-session serialization** — Mutex to prevent overlapping captures
5. **DB access functions** — `insertCheckpoint()`, `getCheckpoints()`, `getLatestCheckpoint()`, `deleteCheckpointsAfter()`
6. **RPC endpoints** — `getCheckpoints`, `getCheckpointDiff`, `revertToCheckpoint` on OrkaService
7. **Revert implementation** — git restore + clean + ref cleanup
8. **Prune integration** — Delete checkpoint refs when session is pruned
9. **Tests** — Unit tests for checkpoint capture (mock git), E2E test for full turn→checkpoint→diff→revert cycle
