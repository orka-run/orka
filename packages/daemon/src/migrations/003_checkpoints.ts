import type { Kysely } from "@orka/core/migrate";
import { sql } from "@orka/core/migrate";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_seq INTEGER NOT NULL,
      git_ref TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      files TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, turn_seq)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_checkpoints_session ON checkpoints(session_id, turn_seq)
  `.execute(db);
}
