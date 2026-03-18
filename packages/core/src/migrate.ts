/**
 * Shared Kysely migration runner for bun:sqlite databases.
 *
 * Usage:
 *   import { runMigrations } from "@orka/core/migrate";
 *   await runMigrations(db, dbPath, migrations, legacyMigrationCount);
 *
 * - `db`: an open bun:sqlite Database instance (PRAGMAs already set)
 * - `dbPath`: absolute path to the .db file (for backup)
 * - `migrations`: a record of migration name → { up, down? } (Kysely Migration format)
 * - `legacyMigrationCount`: how many of the first N migrations correspond to the old
 *   inline migration system. When transitioning from the legacy `schema_migrations`
 *   table, these are pre-seeded into Kysely's tracking table so they aren't re-run.
 */
import type { Database } from "bun:sqlite";
import { Kysely, Migrator, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { copyFileSync, existsSync } from "node:fs";

export type { Migration, Kysely } from "kysely";
export { sql } from "kysely";

export interface MigrationResult {
  /** Names of migrations that were successfully applied in this run. */
  migrationsRun: string[];
  /** If a migration failed, the error message. */
  error?: string;
}

export async function runMigrations(
  db: Database,
  dbPath: string,
  migrations: Record<string, Migration>,
  legacyMigrationCount: number,
): Promise<MigrationResult> {
  const hasLegacy = tableExists(db, "schema_migrations");

  // Kysely instance is used ONLY for migrations — never call destroy()
  // because that would close the underlying bun:sqlite Database.
  const kysely = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: db }),
  });

  const provider: MigrationProvider = {
    async getMigrations() {
      return migrations;
    },
  };

  const migrator = new Migrator({ db: kysely, provider });

  // Transition: pre-seed Kysely's migration table from legacy schema_migrations
  if (hasLegacy) {
    await transitionFromLegacy(kysely, migrations, legacyMigrationCount);
  }

  // Count pending migrations to decide whether to backup
  const appliedNames = await getAppliedMigrations(kysely);
  const sortedNames = Object.keys(migrations).sort();
  const pendingCount = sortedNames.filter((n) => !appliedNames.has(n)).length;

  if (pendingCount > 0 && existsSync(dbPath)) {
    const version = appliedNames.size;
    const backupPath = `${dbPath}.bak-v${version}`;
    if (!existsSync(backupPath)) {
      copyFileSync(dbPath, backupPath);
    }
  }

  // Run pending migrations
  const { error, results } = await migrator.migrateToLatest();

  const migrationsRun = (results ?? [])
    .filter((r) => r.status === "Success")
    .map((r) => r.migrationName);

  if (error) {
    return { migrationsRun, error: String(error) };
  }

  // Clean up legacy table after successful transition
  if (hasLegacy) {
    db.exec("DROP TABLE IF EXISTS schema_migrations");
  }

  return { migrationsRun };
}

/** Pre-seed Kysely's migration tracking table based on legacy schema_migrations. */
async function transitionFromLegacy(
  kysely: Kysely<any>,
  migrations: Record<string, Migration>,
  legacyMigrationCount: number,
): Promise<void> {
  // Ensure Kysely's migration tables exist
  await sql`
    CREATE TABLE IF NOT EXISTS kysely_migration (
      name varchar(255) NOT NULL PRIMARY KEY,
      timestamp varchar(255) NOT NULL
    )
  `.execute(kysely);

  await sql`
    CREATE TABLE IF NOT EXISTS kysely_migration_lock (
      id varchar(255) NOT NULL PRIMARY KEY,
      is_locked integer NOT NULL DEFAULT 0
    )
  `.execute(kysely);

  await sql`
    INSERT OR IGNORE INTO kysely_migration_lock (id, is_locked) VALUES ('migration_lock', 0)
  `.execute(kysely);

  // Pre-seed the first N migrations as already applied
  const sortedNames = Object.keys(migrations).sort();
  const toPreSeed = sortedNames.slice(0, legacyMigrationCount);
  const now = new Date().toISOString();

  for (const name of toPreSeed) {
    await sql`
      INSERT OR IGNORE INTO kysely_migration (name, timestamp) VALUES (${name}, ${now})
    `.execute(kysely);
  }
}

async function getAppliedMigrations(kysely: Kysely<any>): Promise<Set<string>> {
  try {
    const result = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(kysely);
    return new Set(result.rows.map((r) => r.name));
  } catch {
    // Table doesn't exist yet — first run
    return new Set();
  }
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== null;
}
