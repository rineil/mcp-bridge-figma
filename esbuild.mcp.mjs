/**
 * Bundle MCP stdio server into a single JS file so Cursor can run `node dist-mcp/server.js`
 * with no pnpm/tsx noise on stdout (required for JSON-RPC over stdio).
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, "src", "mcp", "server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(__dirname, "dist-mcp", "server.js"),
  logLevel: "info",
  packages: "bundle",
});
