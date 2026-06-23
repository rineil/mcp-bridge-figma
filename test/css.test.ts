import { describe, it, expect } from "vitest";
import {
  cssBoxShadow,
  cssBlurFilters,
  cssLineHeight,
  cssLetterSpacing,
  cssTextTransform,
  cssTextDecoration,
  cssGradient,
  gradientStopsCss,
  buildNodeCss,
} from "../plugin/pure";

describe("cssBoxShadow", () => {
  it("composes a drop shadow", () => {
    expect(
      cssBoxShadow([
        { type: "DROP_SHADOW", offset: { x: 0, y: 4 }, radius: 8, spread: 0, cssColor: "rgba(0, 0, 0, 0.2)" },
      ]),
    ).toBe("0px 4px 8px 0px rgba(0, 0, 0, 0.2)");
  });
  it("prefixes inner shadows with inset and joins multiple", () => {
    expect(
      cssBoxShadow([
        { type: "DROP_SHADOW", offset: { x: 1, y: 1 }, radius: 2, spread: 0, cssColor: "#000" },
        { type: "INNER_SHADOW", offset: { x: 0, y: 0 }, radius: 4, spread: 1, cssColor: "#fff" },
      ]),
    ).toBe("1px 1px 2px 0px #000, inset 0px 0px 4px 1px #fff");
  });
  it("skips invisible/non-shadow effects, returns undefined when none", () => {
    expect(
      cssBoxShadow([
        { type: "DROP_SHADOW", visible: false, cssColor: "#000" },
        { type: "LAYER_BLUR", radius: 4 },
      ]),
    ).toBeUndefined();
  });
});

describe("cssBlurFilters", () => {
  it("maps layer/background blur", () => {
    expect(cssBlurFilters([{ type: "LAYER_BLUR", radius: 4 }])).toEqual({ filter: "blur(4px)" });
    expect(cssBlurFilters([{ type: "BACKGROUND_BLUR", radius: 8 }])).toEqual({ backdropFilter: "blur(8px)" });
  });
});

describe("text CSS conversions", () => {
  it("lineHeight", () => {
    expect(cssLineHeight({ unit: "AUTO" })).toBe("normal");
    expect(cssLineHeight({ value: 24, unit: "PIXELS" })).toBe("24px");
    expect(cssLineHeight({ value: 150, unit: "PERCENT" })).toBe("1.5");
    expect(cssLineHeight("mixed")).toBeUndefined();
  });
  it("letterSpacing", () => {
    expect(cssLetterSpacing({ value: 2, unit: "PIXELS" })).toBe("2px");
    expect(cssLetterSpacing({ value: 5, unit: "PERCENT" })).toBe("0.05em");
  });
  it("textTransform / textDecoration", () => {
    expect(cssTextTransform("UPPER")).toBe("uppercase");
    expect(cssTextTransform("ORIGINAL")).toBeUndefined();
    expect(cssTextDecoration("UNDERLINE")).toBe("underline");
    expect(cssTextDecoration("STRIKETHROUGH")).toBe("line-through");
  });
});

describe("gradientStopsCss + cssGradient", () => {
  const stops = [
    { position: 0, cssColor: "#ffffff" },
    { position: 1, cssColor: "#000000" },
  ];
  it("formats stops as color pos%", () => {
    expect(gradientStopsCss(stops)).toBe("#ffffff 0%, #000000 100%");
  });
  it("identity transform on a square -> 90deg (Figma default left->right)", () => {
    const g = cssGradient(
      { type: "GRADIENT_LINEAR", gradientStops: stops, gradientTransform: [[1, 0, 0], [0, 1, 0]] },
      100,
      100,
    );
    expect(g).toBe("linear-gradient(90deg, #ffffff 0%, #000000 100%)");
  });
  it("swap transform -> 180deg (top->bottom)", () => {
    const g = cssGradient(
      { type: "GRADIENT_LINEAR", gradientStops: stops, gradientTransform: [[0, 1, 0], [1, 0, 0]] },
      100,
      100,
    );
    expect(g).toBe("linear-gradient(180deg, #ffffff 0%, #000000 100%)");
  });
  it("radial -> radial-gradient, angular -> conic-gradient", () => {
    expect(cssGradient({ type: "GRADIENT_RADIAL", gradientStops: stops })).toBe(
      "radial-gradient(#ffffff 0%, #000000 100%)",
    );
    expect(cssGradient({ type: "GRADIENT_ANGULAR", gradientStops: stops })).toBe(
      "conic-gradient(#ffffff 0%, #000000 100%)",
    );
  });
  it("undefined when no stops", () => {
    expect(cssGradient({ type: "GRADIENT_LINEAR", gradientStops: [] })).toBeUndefined();
  });
});

describe("buildNodeCss", () => {
  it("composes background/radius/shadow/opacity + absolute box", () => {
    const css = buildNodeCss(
      {
        fills: [{ type: "SOLID", cssColor: "#ffffff" }],
        cornerRadius: 8,
        opacity: 0.5,
        effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 4, spread: 0, cssColor: "#000" }],
        rel: { x: 10, y: 20, width: 100, height: 50 },
      },
      { absolute: true },
    );
    expect(css).toEqual({
      background: "#ffffff",
      borderRadius: "8px",
      boxShadow: "0px 2px 4px 0px #000",
      opacity: 0.5,
      position: "absolute",
      left: "10px",
      top: "20px",
      width: "100px",
      height: "50px",
    });
  });
  it("uses cssGradient background and border from stroke", () => {
    const css = buildNodeCss({
      fills: [{ type: "GRADIENT_LINEAR", cssGradient: "linear-gradient(90deg, #fff 0%, #000 100%)" }],
      strokes: [{ type: "SOLID", cssColor: "#333333" }],
      strokeWeight: 2,
    }) as Record<string, string>;
    expect(css.background).toBe("linear-gradient(90deg, #fff 0%, #000 100%)");
    expect(css.border).toBe("2px solid #333333");
  });
  it("omits absolute box without rel; returns undefined when empty", () => {
    expect(buildNodeCss({}, { absolute: true })).toBeUndefined();
  });
  it("per-corner radius tuple", () => {
    const css = buildNodeCss({ rectangleCornerRadii: [8, 8, 0, 0] }) as Record<string, string>;
    expect(css.borderRadius).toBe("8px 8px 0px 0px");
  });
});
