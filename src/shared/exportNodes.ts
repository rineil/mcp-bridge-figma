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

export type NodeChange = {
  id: string;
  name: string;
  type: string;
  change: "added" | "removed" | "modified";
};

/**
 * Compare two exports by their per-node Merkle `hash`. Because a node's hash
 * covers its descendants, an unchanged hash prunes that whole subtree — so this
 * walks only the parts that actually moved.
 *
 * "modified" is reported for the shallowest node whose own fields changed; a
 * node whose hash differs only because a descendant changed is not itself
 * listed, keeping the result to real edit sites rather than every ancestor.
 */
export function diffTrees(
  before: ExportNode[],
  after: ExportNode[],
): NodeChange[] {
  const out: NodeChange[] = [];
  const describe = (n: ExportNode): Omit<NodeChange, "change"> => ({
    id: String(n.id ?? ""),
    name: String(n.name ?? ""),
    type: String(n.type ?? ""),
  });

  const markAll = (nodes: ExportNode[], change: "added" | "removed"): void => {
    for (const n of nodes) {
      out.push({ ...describe(n), change });
    }
  };

  const walk = (a: ExportNode[], b: ExportNode[]): void => {
    const byId = new Map<string, ExportNode>();
    for (const n of a) {
      byId.set(String(n.id ?? ""), n);
    }
    const seen = new Set<string>();
    for (const nb of b) {
      const id = String(nb.id ?? "");
      seen.add(id);
      const na = byId.get(id);
      if (!na) {
        out.push({ ...describe(nb), change: "added" });
        continue;
      }
      // Identical subtree — nothing below can differ, so stop descending.
      if (na.hash && nb.hash && na.hash === nb.hash) {
        continue;
      }
      // Own-field digest: strip children/hash the same way the plugin does.
      const ownA = ownDigest(na);
      const ownB = ownDigest(nb);
      if (ownA !== ownB) {
        out.push({ ...describe(nb), change: "modified" });
      }
      walk(nodeChildren(na), nodeChildren(nb));
    }
    for (const [id, na] of byId) {
      if (!seen.has(id)) {
        markAll([na], "removed");
      }
    }
  };

  walk(before, after);
  return out;
}

/** Stable digest of a node's own fields, excluding `children` and `hash`. */
function ownDigest(n: ExportNode): string {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(n)) {
    if (k !== "children" && k !== "hash") {
      rest[k] = (n as Record<string, unknown>)[k];
    }
  }
  return stableKeyStringify(rest);
}

function stableKeyStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableKeyStringify).join(",")}]`;
  }
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKeyStringify(o[k])}`)
    .join(",")}}`;
}
