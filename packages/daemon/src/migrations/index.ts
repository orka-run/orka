import type { Migration } from "@orka/core/migrate";
import * as m001 from "./001_initial";
import * as m002 from "./002_backfill_workspaces";
import * as m003 from "./003_checkpoints";

export const daemonMigrations: Record<string, Migration> = {
  "001_initial": m001,
  "002_backfill_workspaces": m002,
  "003_checkpoints": m003,
};
