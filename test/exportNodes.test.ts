import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  asRoots,
  outline,
  findNodeById,
  limitDepth,
  searchNodes,
} from "../src/shared/exportNodes";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "sample-export.json"), "utf8"),
);
const roots = asRoots(fixture.roots);

describe("outline", () => {
  it("prunes at maxDepth and strips heavy fields", () => {
    const o = outline(roots[0], 1) as any;
    expect(o.id).toBe("1:1");
    expect(o.childCount).toBe(2);
    expect("fills" in o).toBe(false); // heavy fields stripped
    const button = o.children.find((c: any) => c.id === "1:3");
    expect(button.childCount).toBe(1);
    expect(button.childrenOmitted).toBe(true); // depth-1 prune
    expect("children" in button).toBe(false);
  });
  it("maxDepth 0 omits all children", () => {
    expect((outline(roots[0], 0) as any).childrenOmitted).toBe(true);
  });
});

describe("findNodeById", () => {
  it("finds a deeply nested node", () => {
    expect(findNodeById(roots, "1:4")?.name).toBe("Home Icon");
  });
  it("returns null when absent", () => {
    expect(findNodeById(roots, "9:9")).toBeNull();
  });
});

describe("limitDepth", () => {
  it("returns the subtree, trimming beyond maxDepth", () => {
    const node = findNodeById(roots, "1:1")!;
    const trimmed = limitDepth(node, 1) as any;
    const button = trimmed.children.find((c: any) => c.id === "1:3");
    expect(button.childrenOmitted).toBe(true);
    expect(button.childCount).toBe(1);
  });
  it("full subtree when depth not limited", () => {
    const node = findNodeById(roots, "1:3")!;
    const full = limitDepth(node, -1) as any;
    expect(full.children[0].id).toBe("1:4");
  });
});

describe("searchNodes", () => {
  it("matches by name (case-insensitive)", () => {
    expect(searchNodes(roots, "icon", 10).map((h) => h.id)).toEqual(["1:4"]);
  });
  it("matches by type", () => {
    expect(searchNodes(roots, "frame", 10).map((h) => h.id).sort()).toEqual([
      "1:1",
      "1:3",
    ]);
  });
  it("honors the limit", () => {
    expect(searchNodes(roots, "", 1)).toHaveLength(1);
  });
});
