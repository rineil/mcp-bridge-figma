import { describe, it, expect } from "vitest";
import { fitPreviewScale } from "../plugin/pure";

const MAX_PX = 1600;
const MAX_SCALE = 2;
const fit = (w: number, h: number): number =>
  fitPreviewScale(w, h, MAX_PX, MAX_SCALE);

describe("fitPreviewScale", () => {
  it("scales a desktop screen down to fit the long edge", () => {
    // 1920x1000 -> width is the binding axis: 1600/1920.
    expect(fit(1920, 1000)).toBeCloseTo(0.8333, 4);
    expect(Math.round(1920 * fit(1920, 1000))).toBe(1600);
  });

  it("binds on height for a tall frame, not width", () => {
    // The bug this guards: fitting width alone would return 1600/1920 and
    // render a 13815px-tall PNG.
    const s = fit(1920, 13815);
    expect(s).toBeCloseTo(1600 / 13815, 6);
    expect(Math.round(13815 * s)).toBe(1600);
    expect(1920 * s).toBeLessThan(MAX_PX);
  });

  it("caps upscaling of small nodes at maxScale", () => {
    expect(fit(64, 64)).toBe(MAX_SCALE);
    expect(fit(1, 1)).toBe(MAX_SCALE);
  });

  it("never exceeds maxPx on either axis", () => {
    for (const [w, h] of [
      [1920, 1000],
      [4232, 1200],
      [390, 844],
      [13815, 200],
      [2160, 13815],
    ] as Array<[number, number]>) {
      const s = fit(w, h);
      expect(w * s).toBeLessThanOrEqual(MAX_PX + 0.001);
      expect(h * s).toBeLessThanOrEqual(MAX_PX + 0.001);
    }
  });

  it("returns 0 for a degenerate box so the caller can skip it", () => {
    expect(fit(0, 500)).toBe(0);
    expect(fit(500, 0)).toBe(0);
    expect(fit(-10, 10)).toBe(0);
    expect(fit(Number.NaN, 10)).toBe(0);
  });
});
