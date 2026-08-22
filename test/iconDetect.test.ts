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
  it("includes designer-marked nodes within a sane icon size", () => {
    expect(isIconCandidate({ ...base, marked: true }, MAX)).toBe(true);
    // Marked illustrations somewhat over the icon cap still count (4x bound).
    expect(
      isIconCandidate({ ...base, marked: true, width: 200, height: 200 }, MAX),
    ).toBe(true);
  });

  it("does NOT let a marked screen-sized frame swallow the walk", () => {
    // Regression: the user had ticked Export on a whole 1920x1000 screen frame;
    // marked=true short-circuited at the root, recursion stopped, and the
    // capture produced one 15MB skipped SVG and zero icons. An oversized marked
    // node must be descended into, not exported as "the icon".
    expect(
      isIconCandidate(
        { ...base, marked: true, width: 1920, height: 1000 },
        MAX,
      ),
    ).toBe(false);
    expect(
      isIconCandidate({ ...base, marked: true, width: 500, height: 500 }, MAX),
    ).toBe(false);
  });

  it("includes a bare icon-font TEXT glyph — no wrapper, no vector", () => {
    // The Đăng ký screen draws input icons as naked TEXT nodes in Font Awesome
    // (18x17). There is nothing else to detect on them.
    expect(
      isIconCandidate(
        {
          ...base,
          type: "TEXT",
          width: 18,
          height: 17,
          hasIconFontText: true,
        },
        MAX,
      ),
    ).toBe(true);
    // A reading-font TEXT of the same size is a label, not an icon.
    expect(
      isIconCandidate(
        { ...base, type: "TEXT", width: 18, height: 17, hasPlainText: true },
        MAX,
      ),
    ).toBe(false);
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
