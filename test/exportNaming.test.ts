import { describe, it, expect } from "vitest";
import { slugFileKey, exportFilenamePrefix } from "../src/shared/exportNaming";

describe("slugFileKey", () => {
  it("collapses unsafe chars and prevents path traversal", () => {
    expect(slugFileKey("My / Design")).toBe("My_Design");
    expect(slugFileKey("../../etc/passwd")).toBe("_etc_passwd");
    expect(slugFileKey("a.b/c")).toBe("a_b_c");
  });
  it("never returns empty (empty -> 'file'; all-separators collapse to '_')", () => {
    expect(slugFileKey("")).toBe("file");
    expect(slugFileKey("///")).toBe("_");
  });
  it("caps length to 64", () => {
    expect(slugFileKey("a".repeat(200)).length).toBe(64);
  });
});

describe("exportFilenamePrefix", () => {
  it("prefers fileKey", () => {
    expect(exportFilenamePrefix({ fileKey: "abc123", fileName: "X" })).toBe(
      "abc123",
    );
  });
  it("falls back to fileName when fileKey is missing/blank", () => {
    expect(exportFilenamePrefix({ fileKey: null, fileName: "My Design" })).toBe(
      "My_Design",
    );
    expect(exportFilenamePrefix({ fileKey: "  ", fileName: "Draft" })).toBe(
      "Draft",
    );
  });
  it("defaults to 'export' when nothing usable", () => {
    expect(exportFilenamePrefix({})).toBe("export");
  });
});
