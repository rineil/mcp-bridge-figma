import { describe, it, expect } from "vitest";
import { gateAssetFormats } from "../plugin/pure";

describe("gateAssetFormats", () => {
  it("exports nothing when the user allowed nothing, even if the AI asks", () => {
    // The checkboxes are a permission gate: no tick, no asset, ever.
    expect(gateAssetFormats([], ["svg", "png"])).toEqual([]);
    expect(gateAssetFormats([])).toEqual([]);
  });

  it("falls back to the user's full allowlist when the AI asks for nothing", () => {
    expect(gateAssetFormats(["svg", "png"])).toEqual(["svg", "png"]);
    expect(gateAssetFormats(["svg", "png"], [])).toEqual(["svg", "png"]);
  });

  it("narrows the AI's request to what the user permitted", () => {
    expect(gateAssetFormats(["svg"], ["svg", "png"])).toEqual(["svg"]);
    expect(gateAssetFormats(["svg", "pdf"], ["png", "pdf"])).toEqual(["pdf"]);
  });

  it("drops a requested format the user never allowed", () => {
    // AI asks for PNG, user only ticked SVG -> PNG is refused.
    expect(gateAssetFormats(["svg"], ["png"])).toEqual([]);
  });

  it("preserves the AI's order within the allowed set", () => {
    expect(gateAssetFormats(["svg", "png", "jpg"], ["jpg", "svg"])).toEqual([
      "jpg",
      "svg",
    ]);
  });
});

import { assetContentKey } from "../plugin/pure";

describe("assetContentKey", () => {
  it("is identical for identical content regardless of request order", () => {
    const a = assetContentKey([["svg", "<svg>x</svg>"], ["png", "AAAA"]]);
    const b = assetContentKey([["png", "AAAA"], ["svg", "<svg>x</svg>"]]);
    expect(a).toBe(b);
  });

  it("differs when any format's content differs", () => {
    const a = assetContentKey([["svg", "<svg>x</svg>"]]);
    const b = assetContentKey([["svg", "<svg>y</svg>"]]);
    expect(a).not.toBe(b);
  });

  it("keeps override-recoloured icons distinct (same component, new fill)", () => {
    // The reason dedup hashes CONTENT and not the source component id: two
    // instances of one component can render different bytes via overrides.
    const white = assetContentKey([["svg", '<path fill="white"/>']]);
    const dark = assetContentKey([["svg", '<path fill="#020618"/>']]);
    expect(white).not.toBe(dark);
  });

  it("differs when one side has an extra format", () => {
    const a = assetContentKey([["svg", "s"]]);
    const b = assetContentKey([["svg", "s"], ["png", "p"]]);
    expect(a).not.toBe(b);
  });
});
