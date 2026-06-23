/**
 * Pure helpers for deriving an export filename prefix from plugin-supplied meta.
 * Extracted from the bridge so they can be unit-tested (path-safety matters).
 */

/** Collapse anything non [A-Za-z0-9_-] to "_", cap length, never empty. */
export function slugFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "file";
}

/** Figma often omits `fileKey` (draft/local); fall back to document name, then "export". */
export function exportFilenamePrefix(meta: {
  fileKey?: string | null;
  fileName?: string;
}): string {
  const fk = meta.fileKey;
  if (fk != null && String(fk).trim() !== "") {
    return slugFileKey(String(fk));
  }
  const name = meta.fileName;
  if (name != null && String(name).trim() !== "") {
    return slugFileKey(String(name));
  }
  return "export";
}
