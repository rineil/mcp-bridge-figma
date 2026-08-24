import { describe, it, expect } from "vitest";
import { attachHashes, hashString, stableStringify } from "../plugin/pure";
import { diffTrees, type ExportNode } from "../src/shared/exportNodes";

const tree = (): Record<string, unknown> => ({
  id: "1:1",
  name: "Screen",
  type: "FRAME",
  children: [
    { id: "1:2", name: "Title", type: "TEXT", text: { characters: "Hello" } },
    {
      id: "1:3",
      name: "Card",
      type: "FRAME",
      children: [{ id: "1:4", name: "Price", type: "TEXT", css: {} }],
    },
  ],
});

const hashed = (): ExportNode[] => {
  const t = tree();
  attachHashes(t);
  return [t as ExportNode];
};

describe("stableStringify", () => {
  it("is insensitive to key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("preserves array order, which is meaningful for children", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("hashString", () => {
  it("is deterministic and 8 hex chars", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
  it("separates different inputs", () => {
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});

describe("attachHashes", () => {
  it("gives every node a hash", () => {
    const t = tree();
    attachHashes(t);
    const kids = t.children as Record<string, unknown>[];
    expect(t.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(kids[0].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(
      (kids[1].children as Record<string, unknown>[])[0].hash,
    ).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable across runs on identical input", () => {
    const a = tree();
    const b = tree();
    expect(attachHashes(a)).toBe(attachHashes(b));
  });

  it("propagates a deep change up to the root (Merkle property)", () => {
    const a = tree();
    const b = tree();
    // Edit the deepest node only.
    ((b.children as Record<string, unknown>[])[1].children as Record<
      string,
      unknown
    >[])[0].name = "Price CHANGED";
    const ha = attachHashes(a);
    const hb = attachHashes(b);
    expect(ha).not.toBe(hb);
    // The untouched sibling keeps its hash, so a diff can prune it.
    const sibA = (a.children as Record<string, unknown>[])[0];
    const sibB = (b.children as Record<string, unknown>[])[0];
    expect(sibA.hash).toBe(sibB.hash);
  });

  it("ignores a pre-existing hash field when rehashing", () => {
    const a = tree();
    attachHashes(a);
    const first = a.hash;
    const second = attachHashes(a);
    expect(second).toBe(first);
  });
});

describe("diffTrees", () => {
  it("reports nothing for identical trees", () => {
    expect(diffTrees(hashed(), hashed())).toEqual([]);
  });

  it("reports the edited node, not its ancestors", () => {
    const before = hashed();
    const t = tree();
    ((t.children as Record<string, unknown>[])[1].children as Record<
      string,
      unknown
    >[])[0].name = "Price CHANGED";
    attachHashes(t);
    const changes = diffTrees(before, [t as ExportNode]);
    expect(changes).toEqual([
      { id: "1:4", name: "Price CHANGED", type: "TEXT", change: "modified" },
    ]);
  });

  it("detects an added node", () => {
    const before = hashed();
    const t = tree();
    (t.children as Record<string, unknown>[]).push({
      id: "1:9",
      name: "Badge",
      type: "TEXT",
    });
    attachHashes(t);
    const changes = diffTrees(before, [t as ExportNode]);
    expect(changes).toContainEqual({
      id: "1:9",
      name: "Badge",
      type: "TEXT",
      change: "added",
    });
  });

  it("detects a removed node", () => {
    const before = hashed();
    const t = tree();
    (t.children as Record<string, unknown>[]).splice(0, 1);
    attachHashes(t);
    const changes = diffTrees(before, [t as ExportNode]);
    expect(changes).toContainEqual({
      id: "1:2",
      name: "Title",
      type: "TEXT",
      change: "removed",
    });
  });

  it("still diffs exports that predate per-node hashes", () => {
    const strip = (n: Record<string, unknown>): Record<string, unknown> => {
      delete n.hash;
      (n.children as Record<string, unknown>[] | undefined)?.forEach(strip);
      return n;
    };
    const before = [strip(tree()) as ExportNode];
    const t = strip(tree());
    (t.children as Record<string, unknown>[])[0].name = "Title CHANGED";
    const changes = diffTrees(before, [t as ExportNode]);
    expect(changes).toContainEqual({
      id: "1:2",
      name: "Title CHANGED",
      type: "TEXT",
      change: "modified",
    });
  });
});
