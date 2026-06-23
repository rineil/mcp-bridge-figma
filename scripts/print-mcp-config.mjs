/**
 * Prints a ready-to-paste MCP client config (Cursor / Claude) for this checkout,
 * with absolute paths resolved so the common "Cannot find module" failure can't
 * happen. Usage: `pnpm print-mcp-config`  (optionally set FIGMA_EXPORT_DIR).
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "dist-mcp", "server.js");
const exportsDir = process.env.FIGMA_EXPORT_DIR
  ? resolve(process.cwd(), process.env.FIGMA_EXPORT_DIR)
  : join(root, "exports");

const config = {
  mcpServers: {
    "figma-bridge": {
      command: "node",
      args: [server],
      env: { FIGMA_EXPORT_DIR: exportsDir },
    },
  },
};

// Note on stderr so stdout stays clean JSON you can pipe.
process.stderr.write(
  "Paste into your MCP client config (run `pnpm build:mcp` first):\n",
);
process.stdout.write(JSON.stringify(config, null, 2) + "\n");
