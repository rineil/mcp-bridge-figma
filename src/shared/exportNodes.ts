/**
 * Utilities for navigating a serialized Figma export tree (plain JSON nodes),
 * so MCP tools can return outlines / subtrees instead of the whole file.
 */

export type ExportNode = Record<string, unknown> & {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  children?: unknown;
};

export function nodeChildren(node: ExportNode): ExportNode[] {
  return Array.isArray(node.children) ? (node.children as ExportNode[]) : [];
}

export function asRoots(value: unknown): ExportNode[] {
  return Array.isArray(value) ? (value as ExportNode[]) : [];
}

/** Lightweight tree-of-contents: id/name/type/bbox/childCount, pruned at maxDepth. */
export function outline(node: ExportNode, maxDepth: number, depth = 0): unknown {
  const kids = nodeChildren(node);
  const o: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    bbox: node.bbox,
    childCount: kids.length,
  };
  if (kids.length > 0) {
    if (depth < maxDepth) {
      o.children = kids.map((k) => outline(k, maxDepth, depth + 1));
    } else {
      o.childrenOmitted = true;
    }
  }
  return o;
}

/** Depth-first search for a node by id across roots. */
export function findNodeById(roots: ExportNode[], id: string): ExportNode | null {
  for (const r of roots) {
    const found = findRec(r, id);
    if (found) {
      return found;
    }
  }
  return null;
}

function findRec(node: ExportNode, id: string): ExportNode | null {
  if (node.id === id) {
    return node;
  }
  for (const k of nodeChildren(node)) {
    const f = findRec(k, id);
    if (f) {
      return f;
    }
  }
  return null;
}

/** Copy of node with children pruned beyond maxDepth. maxDepth < 0 = unlimited. */
export function limitDepth(node: ExportNode, maxDepth: number, depth = 0): ExportNode {
  const kids = nodeChildren(node);
  if (kids.length === 0) {
    return node;
  }
  if (maxDepth >= 0 && depth >= maxDepth) {
    const { children: _children, ...rest } = node;
    return { ...rest, childCount: kids.length, childrenOmitted: true };
  }
  return {
    ...node,
    children: kids.map((k) => limitDepth(k, maxDepth, depth + 1)),
  };
}

export type NodeHit = {
  id: unknown;
  name: unknown;
  type: unknown;
  bbox: unknown;
};

/** Find nodes whose name or type contains the query (case-insensitive). */
export function searchNodes(
  roots: ExportNode[],
  query: string,
  limit: number,
): NodeHit[] {
  const q = query.toLowerCase();
  const out: NodeHit[] = [];
  const walk = (node: ExportNode): void => {
    if (out.length >= limit) {
      return;
    }
    const name = typeof node.name === "string" ? node.name.toLowerCase() : "";
    const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
    if (name.includes(q) || type.includes(q)) {
      out.push({ id: node.id, name: node.name, type: node.type, bbox: node.bbox });
    }
    for (const k of nodeChildren(node)) {
      walk(k);
    }
  };
  for (const r of roots) {
    walk(r);
  }
  return out;
}

export type ComponentEntry = {
  id: string;
  name: unknown;
  key: unknown;
  remote: unknown;
  count: number;
  instanceIds: string[];
};

/**
 * Group INSTANCE nodes by their main component (phase 3 data), so an agent can
 * recognize repeated components (e.g. "Button x14") and build a reusable library
 * instead of flat duplicated markup. Sorted by usage count, descending.
 */
export function componentInventory(
  roots: ExportNode[],
  maxIds = 50,
): ComponentEntry[] {
  const byId = new Map<string, ComponentEntry>();
  const walk = (node: ExportNode): void => {
    if (node.type === "INSTANCE") {
      const comp = node.component as Record<string, unknown> | undefined;
      const main = comp?.mainComponent as Record<string, unknown> | undefined;
      if (main && typeof main.id === "string") {
        let e = byId.get(main.id);
        if (!e) {
          e = {
            id: main.id,
            name: main.name,
            key: main.key,
            remote: main.remote,
            count: 0,
            instanceIds: [],
          };
          byId.set(main.id, e);
        }
        e.count += 1;
        if (e.instanceIds.length < maxIds && typeof node.id === "string") {
          e.instanceIds.push(node.id);
        }
      }
    }
    for (const k of nodeChildren(node)) {
      walk(k);
    }
  };
  for (const r of roots) {
    walk(r);
  }
  return [...byId.values()].sort((a, b) => b.count - a.count);
}
