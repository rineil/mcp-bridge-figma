import { describe, it, expect } from "vitest";
import {
  isIconCandidate,
  isIconFontFamily,
  type IconClassifyInfo,
} from "../plugin/pure";

const MAX = 64;

const base: IconClassifyInfo = {
  type: "FRAME",
  width: 24,
  height: 24,
  marked: false,
  hasVectorDescendant: false,
  hasIconFontText: false,
  hasPlainText: false,
  nameHasIcon: false,
};

describe("isIconFontFamily", () => {
  it("recognizes the families this design system actually uses", () => {
    expect(isIconFontFamily("Font Awesome 6 Free")).toBe(true);
    expect(isIconFontFamily("Material Icons")).toBe(true);
    expect(isIconFontFamily("Material Symbols Outlined")).toBe(true);
  });
  it("rejects reading fonts", () => {
    expect(isIconFontFamily("Roboto")).toBe(false);
    expect(isIconFontFamily("Inter")).toBe(false);
  });
});

describe("isIconCandidate", () => {
  it("always includes designer-marked nodes regardless of size", () => {
    expect(
      isIconCandidate({ ...base, marked: true, width: 500, height: 500 }, MAX),
    ).toBe(true);
  });

  it("includes raw vectors and boolean ops", () => {
    expect(isIconCandidate({ ...base, type: "VECTOR" }, MAX)).toBe(true);
    expect(isIconCandidate({ ...base, type: "BOOLEAN_OPERATION" }, MAX)).toBe(
      true,
    );
  });

  it("includes a small vector-only container", () => {
    expect(
      isIconCandidate({ ...base, hasVectorDescendant: true }, MAX),
    ).toBe(true);
  });

  it("includes a small Font-Awesome-glyph container — this design's icons", () => {
    // DP RENT_BDS draws icons as TEXT in "Font Awesome 6 Free", not vectors.
    expect(isIconCandidate({ ...base, hasIconFontText: true }, MAX)).toBe(true);
  });

  it("excludes a labelled control (has plain reading text)", () => {
    // "Về Trang chủ" button: FA glyph + Roboto label. Not an icon.
    expect(
      isIconCandidate(
        { ...base, hasIconFontText: true, hasPlainText: true },
        MAX,
      ),
    ).toBe(false);
  });

  it("excludes a whole screen even though it contains vectors", () => {
    // The failure that motivated this: a 1920x1000 frame exported as one 15MB SVG.
    expect(
      isIconCandidate(
        { ...base, width: 1920, height: 1000, hasVectorDescendant: true },
        MAX,
      ),
    ).toBe(false);
  });

  it("lets an icon-named small frame in without descendants info", () => {
    expect(isIconCandidate({ ...base, nameHasIcon: true }, MAX)).toBe(true);
  });

  it("excludes a small empty decoration frame", () => {
    expect(isIconCandidate(base, MAX)).toBe(false);
  });

  it("excludes plain TEXT and RECTANGLE nodes", () => {
    expect(isIconCandidate({ ...base, type: "TEXT" }, MAX)).toBe(false);
    expect(isIconCandidate({ ...base, type: "RECTANGLE" }, MAX)).toBe(false);
  });
});
