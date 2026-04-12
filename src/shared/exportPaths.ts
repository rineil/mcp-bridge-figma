/**
 * Resolves the directory where bridge writes JSON and MCP reads exports.
 * Override with FIGMA_EXPORT_DIR (absolute or relative to cwd).
 */
import { resolve } from "node:path";

export function resolveExportDir(): string {
  const raw = process.env.FIGMA_EXPORT_DIR;
  if (raw && raw.length > 0) {
    return resolve(process.cwd(), raw);
  }
  return resolve(process.cwd(), "exports");
}
