import { describe, it, expect } from "vitest";
import { cssColor, resolveTokens, type VarSnapshot } from "../plugin/pure";

describe("cssColor", () => {
  it("opaque -> #hex", () => {
    expect(cssColor({ r: 1, g: 0, b: 0 })).toBe("#ff0000");
    expect(cssColor({ r: 0.2, g: 0.4, b: 0.6 })).toBe("#336699");
  });
  it("alpha -> rgba()", () => {
    expect(cssColor({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("rgba(0, 0, 0, 0.5)");
  });
  it("folds layer opacity into alpha", () => {
    expect(cssColor({ r: 1, g: 1, b: 1 }, 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });
  it("clamps out-of-range channels", () => {
    expect(cssColor({ r: 2, g: -1, b: 0.5 })).toBe("#ff0080");
  });
});

describe("resolveTokens", () => {
  const snapshot: VarSnapshot = {
    collections: [{ id: "C1", name: "Brand", defaultModeId: "m1" }],
    variables: [
      {
        id: "V1",
        name: "color/primary",
        resolvedType: "COLOR",
        variableCollectionId: "C1",
        valuesByMode: { m1: { r: 0.1, g: 0.2, b: 0.9, a: 1 } },
      },
      {
        id: "V2",
        name: "color/unused",
        resolvedType: "COLOR",
        variableCollectionId: "C1",
        valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 } },
      },
      {
        id: "V3",
        name: "color/aliasOfPrimary",
        resolvedType: "COLOR",
        variableCollectionId: "C1",
        valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "V1" } },
      },
    ],
  };

  it("attaches resolved tokens on bound paints", () => {
    const roots = [
      {
        id: "n1",
        type: "RECTANGLE",
        fills: [{ type: "SOLID", boundVariables: { color: "V3" } }],
      },
    ];
    resolveTokens(roots, snapshot);
    const tk = (roots[0] as any).fills[0].tokens;
    expect(tk.color.name).toBe("color/aliasOfPrimary");
    expect(tk.color.cssColor).toBe("#1a33e6"); // resolved through alias to V1
  });

  it("returns a referenced-only compact table (drops unused, pulls alias targets)", () => {
    const roots = [
      { id: "n1", fills: [{ type: "SOLID", boundVariables: { color: "V3" } }] },
    ];
    const out = resolveTokens(roots, snapshot) as {
      variables: any[];
      collections: any[];
    };
    expect(out.variables.map((v) => v.id).sort()).toEqual(["V1", "V3"]);
    expect(out.collections).toHaveLength(1);
    expect(out.variables.find((v) => v.id === "V3").cssColor).toBe("#1a33e6");
  });

  it("emits an empty table when nothing is referenced", () => {
    const out = resolveTokens([{ id: "n1", fills: [] }], snapshot) as {
      variables: any[];
    };
    expect(out.variables).toHaveLength(0);
  });
});
