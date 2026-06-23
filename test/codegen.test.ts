import { describe, it, expect } from "vitest";
import { codegenNode } from "../src/shared/codegen";

describe("codegenNode", () => {
  it("div container merges layout.css + css, self-closes when empty", () => {
    expect(
      codegenNode({
        type: "FRAME",
        name: "Card",
        layout: { css: { display: "flex", flexDirection: "column" } },
        css: { background: "#ffffff", borderRadius: "8px" },
        children: [],
      }),
    ).toBe(
      '<div style={{ display: "flex", flexDirection: "column", background: "#ffffff", borderRadius: "8px" }} data-name="Card" />',
    );
  });

  it("TEXT -> span with fill as color + font props", () => {
    expect(
      codegenNode({
        type: "TEXT",
        name: "Title",
        css: { background: "#111111" },
        text: {
          characters: "Hello",
          fontSize: 24,
          fontName: { family: "Inter" },
          fontWeight: 700,
          cssLineHeight: "1.5",
        },
      }),
    ).toBe(
      '<span style={{ color: "#111111", fontSize: "24px", fontFamily: "Inter", fontWeight: 700, lineHeight: "1.5" }} data-name="Title">{"Hello"}</span>',
    );
  });

  it("vector geometry -> inline svg path", () => {
    const out = codegenNode({
      type: "VECTOR",
      name: "Icon",
      bbox: { width: 16, height: 16 },
      fills: [{ type: "SOLID", cssColor: "#ff0000", visible: true }],
      geometry: { fillGeometry: [{ windingRule: "NONZERO", data: "M0 0h16v16H0z" }] },
    });
    expect(out).toBe(
      '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z" fill="#ff0000" /></svg>',
    );
  });

  it("IMAGE fill -> img with data-raster key", () => {
    expect(
      codegenNode({
        type: "RECTANGLE",
        name: "Photo",
        css: { borderRadius: "4px" },
        fills: [{ type: "IMAGE", imageHash: "abc123", visible: true }],
      }),
    ).toBe(
      '<img style={{ borderRadius: "4px" }} data-name="Photo" data-raster="abc123" alt="Photo" />',
    );
  });

  it("nests children and respects the depth limit", () => {
    const tree = {
      type: "FRAME",
      name: "Root",
      children: [
        { type: "FRAME", name: "Inner", children: [{ type: "TEXT", text: { characters: "x" } }] },
      ],
    };
    const full = codegenNode(tree, 6);
    expect(full).toContain('<div data-name="Root">');
    expect(full).toContain('<div data-name="Inner">');
    expect(full).toContain('<span>{"x"}</span>');
    // indented two levels under Root
    expect(full).toContain('\n    <span>{"x"}</span>');
  });

  it("depth 0 omits children with a comment", () => {
    const out = codegenNode(
      { type: "FRAME", name: "Root", children: [{ type: "TEXT" }] },
      0,
    );
    expect(out).toBe(
      '<div data-name="Root">{/* 1 children omitted (depth) */}</div>',
    );
  });
});
