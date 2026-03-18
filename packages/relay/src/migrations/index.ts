import type { Migration } from "@orka/core/migrate";
import * as m001 from "./001_initial";

export const relayMigrations: Record<string, Migration> = {
  "001_initial": m001,
};
