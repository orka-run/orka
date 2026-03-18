/**
 * Backfill workspaces from existing session project_paths.
 * Creates workspace entries for sessions that have a project_path but no workspace row.
 * Idempotent: skips if workspaces table already has data.
 */
import type { Kysely } from "@orka/core/migrate";
import { sql } from "@orka/core/migrate";

export async function up(db: Kysely<any>): Promise<void> {
  // Check if there are already workspace rows — if so, skip backfill
  const countResult = await sql<{ cnt: number }>`
    SELECT COUNT(*) AS cnt FROM workspaces
  `.execute(db);
  const wsCount = countResult.rows[0]?.cnt ?? 0;
  if (wsCount > 0) return;

  // Find distinct project paths from sessions
  const pathRows = await sql<{ project_path: string }>`
    SELECT DISTINCT project_path FROM sessions
    WHERE project_path IS NOT NULL AND project_path != ''
  `.execute(db);
  if (pathRows.rows.length === 0) return;

  const { basename } = require("node:path") as typeof import("node:path");
  const now = new Date().toISOString();

  for (const { project_path } of pathRows.rows) {
    const wsId = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const name = basename(project_path);

    await sql`INSERT INTO workspaces (id, name, created_at) VALUES (${wsId}, ${name}, ${now})`.execute(db);
    await sql`INSERT INTO workspace_paths (workspace_id, node_id, project_path) VALUES (${wsId}, '', ${project_path})`.execute(db);
    await sql`UPDATE sessions SET workspace_id = ${wsId} WHERE project_path = ${project_path}`.execute(db);
  }
}
