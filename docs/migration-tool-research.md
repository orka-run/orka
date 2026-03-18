# SQLite Migration Tool Research

## Problem Statement

Orka has a homegrown migration system in two places:
- **Daemon** (`packages/daemon/src/db.ts`): 36 inline migrations as `{ version, sql }` tuples
- **Relay** (`packages/relay/src/db.ts`): 0 migrations yet, all tables created upfront

Current approach is fragile. Recent production bugs (3 fixes in a single day) exposed silent error swallowing that corrupted schema state. The inline migration array doesn't scale well and makes it hard to review individual migrations.

## Requirements

| Requirement | Priority | Notes |
|---|---|---|
| Works with `bun:sqlite` | Must | Bun's built-in SQLite, not better-sqlite3 |
| No ORM / query builder | Must | Raw SQL everywhere |
| Programmatic API | Must | Migrations run on daemon startup |
| Individual migration files | Must | Not a single inline array |
| TypeScript/Bun native | Must | No Go binaries, no Node-only packages |
| Two independent databases | Must | Daemon and relay have separate migration sets |
| Lightweight | Should | No heavy deps for a migration runner |
| Pre-migration backup | Should | Easy to add DB file copy |
| Rollback support | Nice | SQLite ALTER TABLE limits make this hard anyway |
| Concurrent migration safety | Nice | Single-process daemon, low risk |

---

## Tool Evaluation

### Category 1: JS/TS Migration Libraries

#### umzug (Sequelize team)

- **bun:sqlite**: No direct support. Requires custom storage adapter (3 methods).
- **API**: Flexible but complex setup. Custom resolver needed for .sql files.
- **Deps**: 5 dependencies, 428 KB minified / 113 KB gzipped. Includes CLI infrastructure (`@rushstack/ts-command-line`) Orka doesn't need.
- **Rollback**: Yes, full `up`/`down`.
- **Locking**: None built-in.
- **Maintenance**: Active (v3.8.2, Sep 2025). 1.56M weekly downloads.
- **Verdict**: Overkill. You'd write a custom storage adapter that does exactly what our `migrate()` already does, then add 428 KB of deps on top.

#### Kysely Migrator

- **bun:sqlite**: Not native. Requires community dialect `kysely-bun-worker` (101 stars, runs queries in a worker).
- **API**: Clean `Migrator` class with `MigrationProvider`. Raw SQL via `sql` template tag.
- **Deps**: Kysely itself is 180 KB / 0 deps, but needs the community dialect too.
- **Rollback**: Yes, `migrateDown()`.
- **Locking**: Yes, `kysely_migration_lock` table. Best-in-class concurrent safety.
- **Maintenance**: Very active. 2.69M weekly downloads.
- **Verdict**: The locking is genuinely nice, but adding an ORM (180 KB) + community dialect just for migrations is disproportionate. Would become compelling if Orka adopted Kysely for query building.

#### @blackglory/better-sqlite3-migrations

- **bun:sqlite**: Probably works (API overlap), but untested. TypeScript type mismatches likely.
- **API**: Simple. `migrate(db, migrations)`. Uses `PRAGMA user_version` for tracking.
- **Deps**: 3 dependencies, 2.6 KB.
- **Rollback**: Yes, `up`/`down`.
- **Locking**: Yes, `BEGIN IMMEDIATE` transactions.
- **Maintenance**: Moderate. 18 stars, 1K weekly downloads.
- **Verdict**: Closest existing library to what we need, but bun:sqlite compatibility is unverified and risky.

#### drizzle-orm migrator

- **bun:sqlite**: Yes, native support via `drizzle-orm/bun-sqlite/migrator`.
- **API**: `migrate(db, { migrationsFolder })`. Clean programmatic API.
- **Deps**: drizzle-orm is 7.4 KB gzipped, 0 deps. Very light runtime.
- **Rollback**: No. Forward-only.
- **Locking**: None.
- **Migration format**: `.sql` files + proprietary `meta/_journal.json` manifest. Must maintain the journal or migrations won't run.
- **Maintenance**: Very active.
- **Verdict**: The only external tool with native bun:sqlite support. But the proprietary journal manifest is fragile, and you're importing an ORM just for its migrator.

### Category 2: Bun-Native Micro-Libraries

| Library | Stars | Weekly DL | Last Updated | Locking | Rollback |
|---|---|---|---|---|---|
| bun-sqlite-migrations | 25 | 33 | Aug 2023 | No | No |
| migralite | 6 | 0 | 2024 | No | No |
| bun-migrate | 6 | 22 | 2024 | No | No |
| sqlite-auto-migrator | 6 | ~0 | 2024 | No | Yes |

**Verdict**: All have near-zero adoption, questionable maintenance, and provide less functionality than our current hand-rolled solution. Not viable for production use.

### Category 3: CLI Tools (Go Binaries)

| Tool | Stars | bun:sqlite | Programmatic API | Binary Size |
|---|---|---|---|---|
| golang-migrate | 18.2K | No (own driver) | No (shell out) | ~25 MB |
| dbmate | 6.7K | No (own driver) | No (shell out) | ~15-20 MB |
| Atlas | ~7K | No (own driver) | No (shell out) | ~50-70 MB |

All three:
- Cannot share a `bun:sqlite` connection (open their own)
- Require shelling out from Bun (adds startup latency)
- Add a platform-specific binary dependency
- Are well-maintained and battle-tested

**Verdict**: Wrong tool category. These are designed for CI/CD pipelines and Go/Ruby/Python projects, not for programmatic use from a Bun daemon that already owns the database connection.

### Category 4: Heavy Query Builders

#### Knex

- **bun:sqlite**: No. Open issue (#6049) requesting support, unresolved.
- **Deps**: ~8.5 MB total installed + native SQLite driver.
- **Verdict**: Non-starter due to missing bun:sqlite support and massive dependency weight.

---

## Comparison Matrix

| Criterion | umzug | Kysely | drizzle-orm | @blackglory | bun-native libs | CLI tools | Custom |
|---|---|---|---|---|---|---|---|
| **bun:sqlite native** | No | No | Yes | Probably | Yes | No | Yes |
| **Raw SQL migrations** | Yes | Yes (sql tag) | Yes | Yes | Yes | Yes | Yes |
| **Programmatic API** | Yes | Yes | Yes | Yes | Yes | No | Yes |
| **Rollback** | Yes | Yes | No | Yes | No | Yes | Optional |
| **Concurrent locking** | No | Yes | No | Yes | No | N/A | Optional |
| **Bundle size** | 428 KB | 180 KB | 7.4 KB | 2.6 KB | <1 KB | N/A | 0 |
| **Dependencies** | 5 | 0 (+dialect) | 0 | 3 | 0 | Binary | 0 |
| **Maintenance** | Active | Active | Active | Moderate | Stale | Active | N/A |
| **Setup complexity** | High | High | Medium | Low | Low | Medium | Low |

---

## SQLite-Specific Findings

### DDL is Fully Transactional

Verified with Bun's bundled SQLite 3.51.2: `CREATE TABLE`, `ALTER TABLE ADD COLUMN`, `DROP TABLE`, and `CREATE INDEX` are all fully transactional. A failed migration inside `db.transaction()` rolls back cleanly, leaving no trace. This is a major advantage over PostgreSQL and MySQL.

**Implication**: Transaction-per-migration is the correct and safe pattern. No need for golang-migrate's "dirty flag" approach.

### PRAGMA foreign_keys Gotcha

`PRAGMA foreign_keys` cannot be changed inside a transaction (SQLite silently ignores it). Migrations that use the 12-step ALTER TABLE rebuild must toggle foreign keys outside the transaction boundary.

### Supported ALTER TABLE Operations

| Operation | Supported | Since |
|---|---|---|
| ADD COLUMN | Yes | Always |
| RENAME COLUMN | Yes | 3.25.0 |
| DROP COLUMN | Yes | 3.35.0 |
| RENAME TO | Yes | Always |
| Change column type | No | Requires rebuild |
| Add/remove constraints | No | Requires rebuild |

### WAL Mode

Compatible with migrations. Readers proceed while a migration holds the write lock. `PRAGMA busy_timeout = 5000` (already configured) handles contention.

---

## Recommendation: Build Our Own (Improved)

### Why Not a Third-Party Tool

1. **No tool natively supports bun:sqlite** except drizzle-orm (which brings an ORM dependency and proprietary journal format) and abandoned micro-libraries.
2. **The core runner is ~120-150 lines of code.** Every third-party tool adds more configuration overhead than the implementation itself.
3. **Our requirements are simple**: scan a directory, compare against a tracking table, run SQL in transactions. This is not a complex problem.
4. **SQLite's transactional DDL** eliminates the hardest part (partial migration recovery). Most migration tool complexity exists to handle databases where DDL isn't transactional.
5. **We already have a working runner.** The bugs were in error handling, not in the migration model itself.

### What to Build

A shared `@orka/core/migrate.ts` module (~150 lines) used by both daemon and relay:

**Migration file format**: `NNN_snake_case_description.sql` or `NNN_snake_case_description.ts`
```
packages/daemon/migrations/
  001_initial_schema.sql
  002_add_log_file.sql
  ...
  037_add_workspace_indexes.sql
  038_backfill_workspaces.ts     # TypeScript for data migrations

packages/relay/migrations/
  001_initial_schema.sql
```

**Tracking table** (enhanced from current):
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version  INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  checksum TEXT NOT NULL,        -- SHA-256 of file content (detects tampering)
  applied_at TEXT NOT NULL,
  execution_ms INTEGER NOT NULL DEFAULT 0
)
```

**Public API**:
```typescript
interface MigrateOptions {
  db: Database;
  migrationsDir: string;
  backup?: boolean;     // copy .db file before migrating (default: true)
}

interface MigrateResult {
  applied: Array<{ version: number; name: string; ms: number }>;
  current: number;      // highest applied version
}

function migrate(opts: MigrateOptions): Promise<MigrateResult>;
```

**Safety features**:
- Transaction per migration (leveraging SQLite's transactional DDL)
- Checksum verification of previously-applied migrations
- Pre-migration backup (copy .db file, remove on success)
- Duplicate version detection at startup
- Missing file detection (migration recorded but file gone)
- Clear error messages with version number and file name
- SQL files split on `;` boundaries for safe execution

**SQL migration file example** (`001_initial_schema.sql`):
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  backend TEXT NOT NULL DEFAULT 'claude',
  ...
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ...
);
```

**TypeScript migration file example** (`038_backfill_workspaces.ts`):
```typescript
import type { Database } from "bun:sqlite";

export function up(db: Database): void {
  const sessions = db.prepare("SELECT DISTINCT project_path FROM sessions WHERE project_path != ''").all();
  for (const { project_path } of sessions) {
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, ...) VALUES (?, ?, ...)").run(...);
  }
}
```

### What Changes in Existing Code

**Before** (in `openDb`):
```typescript
migrate(db); // inline function with 36 migrations as array
```

**After**:
```typescript
import { migrate } from "@orka/core/migrate";
await migrate({ db, migrationsDir: join(import.meta.dir, "../migrations") });
```

The `migrate()` function in each `db.ts` is deleted. The inline `MIGRATIONS` array is extracted to individual files.

---

## Migration Plan

### Phase 1: Create the shared runner (~150 LOC)
- `packages/core/src/migrate.ts` — the migration runner
- Unit tests with temp databases

### Phase 2: Extract daemon migrations to files
- Convert the initial `CREATE TABLE` block to `001_initial_schema.sql`
- Convert each of the 36 inline migrations to `002_*.sql` through `037_*.sql`
- Convert `backfillWorkspaces` to `038_backfill_workspaces.ts`
- Replace `migrate(db)` in `openDb()` with the new runner
- Verify idempotency: existing databases with `schema_migrations` records must work

### Phase 3: Extract relay migrations to files
- Convert the initial tables to `001_initial_schema.sql`
- Replace `migrate(db)` in `openRelayDb()` with the new runner

### Phase 4: Compatibility bridge (one-time)
- On first run with new runner, detect existing `schema_migrations` records (version-only, no checksum)
- Backfill checksums for already-applied migrations
- After this migration, the enhanced tracking table is in effect

### Risk: Existing databases
The current `schema_migrations` table has `(version INTEGER PRIMARY KEY, applied_at TEXT)`. The new table adds `name`, `checksum`, `execution_ms`. The runner must handle the upgrade:
1. Detect old schema (missing `name` column)
2. ALTER TABLE to add new columns with defaults
3. Backfill checksums from current migration files

---

## Alternatives Considered But Not Recommended

### drizzle-orm migrator (runner only)
The closest viable third-party option. Pros: native bun:sqlite, tiny runtime (7.4 KB). Cons: proprietary `meta/_journal.json` manifest that must be manually maintained, imports an ORM we don't use, no checksum verification, no backup support. We'd still need to wrap it with our own safety logic, negating the benefit.

### Kysely migrator
Best concurrent locking story. But requires a community dialect (`kysely-bun-worker`) that runs queries in a worker thread, adding complexity. The full Kysely package (180 KB) is substantial for migration-only use. Would reconsider if Orka adopts Kysely for query building.

### dbmate (CLI)
Best migration file format (single file with `-- migrate:up` / `-- migrate:down` sections). Well-maintained. But requires a Go binary, can't share bun:sqlite connection, and would need shell-out on every daemon startup. Wrong tool for embedded programmatic use.
