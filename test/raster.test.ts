import { describe, it, expect } from "vitest";
import { sniffImageMime } from "../src/shared/raster";

describe("sniffImageMime", () => {
  it("detects PNG / JPEG / GIF / WEBP from the base64 prefix", () => {
    expect(sniffImageMime("iVBORw0KGgoAAAA")).toBe("image/png");
    expect(sniffImageMime("/9j/4AAQSkZ")).toBe("image/jpeg");
    expect(sniffImageMime("R0lGODlhAQAB")).toBe("image/gif");
    expect(sniffImageMime("UklGRiQAAABXRUJQ")).toBe("image/webp");
  });
  it("defaults to PNG for unknown payloads", () => {
    expect(sniffImageMime("QUJD")).toBe("image/png");
  });
});
