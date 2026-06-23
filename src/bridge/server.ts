/**
 * Standalone local HTTP bridge (`pnpm bridge`): receives JSON from the Figma
 * plugin and persists it for the MCP tools. Default listen: localhost:3845 —
 * POST /export (token-gated), GET /health.
 *
 * The MCP server can also embed this same ingest (see src/mcp/server.ts), so the
 * standalone bridge is optional. Logic lives in src/shared/bridgeCore.ts.
 */
import { resolveExportDir } from "../shared/exportPaths.js";
import {
  createBridgeServer,
  loadOrCreateToken,
} from "../shared/bridgeCore.js";

const PORT = Number(process.env.BRIDGE_PORT ?? "3845");
const HOST = process.env.BRIDGE_HOST ?? "localhost";
const MAX_BYTES = Number(
  process.env.BRIDGE_MAX_BYTES ?? String(64 * 1024 * 1024),
);
const exportDir = resolveExportDir();
const token = loadOrCreateToken(exportDir);

createBridgeServer({ exportDir, token, maxBytes: MAX_BYTES }).listen(
  PORT,
  HOST,
  () => {
    // eslint-disable-next-line no-console
    console.log(`[figma-bridge] http://${HOST}:${PORT}  exportDir=${exportDir}`);
    // eslint-disable-next-line no-console
    console.log(
      `[figma-bridge] token: ${token}\n[figma-bridge] paste this into the plugin's "Bridge token" field (stored once via clientStorage).`,
    );
  },
);
