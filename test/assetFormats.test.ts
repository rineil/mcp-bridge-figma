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
