/**
 * Validates a user-supplied export filename segment (no path traversal).
 */
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/;

export function assertSafeExportBasename(name: string): string {
  const trimmed = name.trim();
  if (!SAFE.test(trimmed) || trimmed.includes("..")) {
    throw new Error("Invalid export name: use only letters, digits, ._- and end with .json");
  }
  return trimmed;
}
