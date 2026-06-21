/**
 * MCP server (stdio): lists and reads JSON files written by the local Figma bridge.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveExportDir } from "../shared/exportPaths.js";
import { assertSafeExportBasename } from "../shared/safeExportName.js";

const exportDir = resolveExportDir();

const server = new McpServer(
  { name: "mcp-bridge-figma", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "figma_bridge_list_exports",
  {
    description:
      "List JSON export files produced by the Reform Figma plugin via the local bridge (newest first).",
    inputSchema: z.object({
      limit: z.number().int().positive().max(200).optional().default(50),
    }),
  },
  async ({ limit }) => {
    let names: string[] = [];
    try {
      names = (await readdir(exportDir)).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    names.sort().reverse();
    const slice = names.slice(0, limit);
    const text = JSON.stringify({ exportDir, files: slice }, null, 2);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "figma_bridge_read_export",
  {
    description:
      "Read one export JSON by basename (e.g. myfile_2026-04-12T12-00-00-000Z.json). Path must stay under the export directory.",
    inputSchema: z.object({
      name: z.string().min(5).describe("Basename ending in .json"),
      maxBytes: z.number().int().positive().max(20_000_000).optional().default(4_000_000),
    }),
  },
  async ({ name, maxBytes }) => {
    const safe = assertSafeExportBasename(name);
    const full = join(exportDir, safe);
    const buf = await readFile(full);
    if (buf.length > maxBytes) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "file_too_large",
                bytes: buf.length,
                maxBytes,
                hint: "Re-export with smaller selection or raise maxBytes.",
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const text = buf.toString("utf8");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "figma_bridge_export_schema_hint",
  {
    description:
      "Return a short description of export JSON phases (1 layout, 2 tokens/variables, 3 components/raster).",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            phase1: "Per-node scene graph: bbox (space=absolute|relative) + `rel` (parent-relative CSS-ready box), fills/strokes (color 0..1 + `cssColor` #hex/rgba, full gradient stops, IMAGE imageHash), container auto-layout (layout, incl. `layout.css` ready flexbox) + per-node sizing/constraints (layoutSelf), vector path geometry (geometry.fillGeometry as SVG paths), isMask/maskType, corner radii, stroke dash/cap/join.",
            phase2: "Adds a COMPACT resolved token table (variables: referenced-only, default-mode value + cssColor) with per-paint `tokens`; text per-range styling (text.segments) + fontWeight; effect detail (shadow cssColor); style IDs.",
            phase3: "Adds component/variant/instance metadata, mainComponent refs, optional PNG raster (base64) for small nodes when enabled in plugin.",
            notes: "Colors are pre-resolved to cssColor — use those directly. imageHash on IMAGE fills is opaque (not a URL); icons come through as geometry.fillGeometry SVG paths.",
            schemaFile: "schema/export-v3.schema.json (repo-relative to mcp-bridge-figma); roots[] items follow $defs/node.",
          },
          null,
          2,
        ),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
