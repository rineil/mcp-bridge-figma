import { describe, it, expect } from "vitest";
import { assertSafeExportBasename } from "../src/shared/safeExportName";

describe("assertSafeExportBasename", () => {
  it("accepts a normal export basename", () => {
    const n = "MyDesign_2026-01-01T00-00-00-000Z.json";
    expect(assertSafeExportBasename(n)).toBe(n);
  });
  it("rejects path traversal and separators", () => {
    expect(() => assertSafeExportBasename("../secret.json")).toThrow();
    expect(() => assertSafeExportBasename("a/b.json")).toThrow();
    expect(() => assertSafeExportBasename("a..b.json")).toThrow();
  });
  it("rejects non-.json and leading dot", () => {
    expect(() => assertSafeExportBasename("file.txt")).toThrow();
    expect(() => assertSafeExportBasename(".bridge-token")).toThrow();
  });
});
