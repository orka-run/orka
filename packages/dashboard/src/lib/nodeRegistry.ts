/**
 * LocalStorage-backed registry of paired node metadata.
 * Stores node identity and connection info after successful pairing.
 */

export interface PairedNode {
  nodeId: string;
  nodeName: string;
  nodePaths: string[];
  relayOrigin: string;
  pairedAt: number;
}

const STORAGE_KEY = "orka-paired-nodes";

export function savePairedNode(node: PairedNode): void {
  const nodes = loadAllPairedNodesMap();
  nodes[node.nodeId] = node;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
}

export function loadPairedNode(nodeId: string): PairedNode | null {
  const nodes = loadAllPairedNodesMap();
  return nodes[nodeId] ?? null;
}

export function loadAllPairedNodes(): PairedNode[] {
  return Object.values(loadAllPairedNodesMap());
}

export function removePairedNode(nodeId: string): void {
  const nodes = loadAllPairedNodesMap();
  delete nodes[nodeId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
}

function loadAllPairedNodesMap(): Record<string, PairedNode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, PairedNode>;
  } catch {
    return {};
  }
}
