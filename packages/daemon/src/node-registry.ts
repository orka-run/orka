import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import type { StoredNode } from "@orka/core";

export interface NodeRegistry {
  save(node: StoredNode): void;
  load(nodeId: string): StoredNode | null;
  loadAll(): StoredNode[];
  remove(nodeId: string): void;
}

export function createNodeRegistry(orkaHome: string): NodeRegistry {
  const nodesDir = join(orkaHome, "nodes");
  mkdirSync(nodesDir, { recursive: true });

  function nodePath(nodeId: string): string {
    return join(nodesDir, `${nodeId}.json`);
  }

  return {
    save(node: StoredNode): void {
      writeFileSync(nodePath(node.nodeId), JSON.stringify(node, null, 2) + "\n");
    },

    load(nodeId: string): StoredNode | null {
      const p = nodePath(nodeId);
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch (err) {
        console.error(`[node-registry] failed to load ${nodeId}:`, err);
        return null;
      }
    },

    loadAll(): StoredNode[] {
      let entries: string[];
      try {
        entries = readdirSync(nodesDir).filter((f) => f.endsWith(".json"));
      } catch (err) {
        console.error("[node-registry] failed to read nodes dir:", err);
        return [];
      }
      const nodes: StoredNode[] = [];
      for (const file of entries) {
        const nodeId = file.replace(/\.json$/, "");
        const node = this.load(nodeId);
        if (node) nodes.push(node);
      }
      return nodes;
    },

    remove(nodeId: string): void {
      try {
        unlinkSync(nodePath(nodeId));
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          console.error(`[node-registry] failed to remove ${nodeId}:`, err);
        }
      }
    },
  };
}
