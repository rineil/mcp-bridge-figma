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
import {
  asRoots,
  findNodeById,
  limitDepth,
  outline,
  searchNodes,
} from "../shared/exportNodes.js";

const exportDir = resolveExportDir();

const server = new McpServer(
  { name: "mcp-bridge-figma", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

type LoadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

/** Read + parse an export JSON by basename, guarding path, size, and JSON validity. */
async function loadExport(name: string, maxBytes: number): Promise<LoadResult> {
  const safe = assertSafeExportBasename(name);
  const full = join(exportDir, safe);
  const buf = await readFile(full);
  if (buf.length > maxBytes) {
    return {
      ok: false,
      error: {
        error: "file_too_large",
        bytes: buf.length,
        maxBytes,
        hint: "Use figma_bridge_export_outline / figma_bridge_read_node to read part of it, or raise maxBytes.",
      },
    };
  }
  try {
    return {
      ok: true,
      data: JSON.parse(buf.toString("utf8")) as Record<string, unknown>,
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        error: "invalid_json",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function jsonText(obj: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

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
            phase1: "Per-node scene graph: bbox (space=absolute|relative) + `rel` (parent-relative box), fills/strokes (`cssColor` #hex/rgba, gradients incl. ready `cssGradient`), and a consolidated per-node `css` block (background/border/borderRadius/boxShadow/filter/opacity + absolute position when not an auto-layout child). Containers also have `layout`+`layout.css` (flexbox); children have `layoutSelf` (FILL/HUG/FIXED). Vector `geometry.fillGeometry` (SVG paths), isMask, corner radii, stroke dash/cap/join.",
            phase2: "Adds a COMPACT resolved token table (variables: referenced-only, default-mode value + cssColor) with per-paint `tokens`; text per-range styling (text.segments) + fontWeight + CSS-ready cssLineHeight/cssLetterSpacing/cssTextTransform/cssTextDecoration; effect detail; style IDs.",
            phase3: "Adds component/variant/instance metadata, mainComponent refs, optional PNG raster (base64) for small nodes when enabled in plugin.",
            notes: "Colors are pre-resolved to cssColor — use those directly. imageHash on IMAGE fills is opaque (not a URL): with phase 3 + raster enabled, fetch its bytes via figma_bridge_get_raster keyed by the imageHash. Icons come through as geometry.fillGeometry SVG paths. For large exports, navigate with figma_bridge_export_outline / search_nodes / read_node instead of reading the whole file.",
            schemaFile: "schema/export-v3.schema.json (repo-relative to mcp-bridge-figma); roots[] items follow $defs/node.",
          },
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  "figma_bridge_export_outline",
  {
    description:
      "Cheap tree-of-contents for an export: meta + pruned node tree (id/name/type/bbox/childCount) with NO fills/effects/text/variables/rasters. Use FIRST to navigate large exports, then read detail with figma_bridge_read_node.",
    inputSchema: z.object({
      name: z.string().min(5).describe("Export basename ending in .json"),
      maxDepth: z.number().int().min(0).max(50).optional().default(4),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(50_000_000)
        .optional()
        .default(20_000_000),
    }),
  },
  async ({ name, maxDepth, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const roots = asRoots(res.data.roots);
    return jsonText({
      meta: res.data.meta,
      outline: roots.map((r) => outline(r, maxDepth)),
    });
  },
);

server.registerTool(
  "figma_bridge_read_node",
  {
    description:
      "Read ONE node subtree from an export by node id (from outline/search). Returns just that node and its descendants (optionally depth-limited), so context cost is proportional to the node, not the whole file.",
    inputSchema: z.object({
      name: z.string().min(5),
      nodeId: z.string().min(1).describe('Node id, e.g. "12:345"'),
      depth: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("Limit descendant depth; omit for the full subtree"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(20_000_000)
        .optional()
        .default(4_000_000),
    }),
  },
  async ({ name, nodeId, depth, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const node = findNodeById(asRoots(res.data.roots), nodeId);
    if (!node) {
      return { ...jsonText({ error: "node_not_found", nodeId }), isError: true };
    }
    return jsonText(typeof depth === "number" ? limitDepth(node, depth) : node);
  },
);

server.registerTool(
  "figma_bridge_search_nodes",
  {
    description:
      "Find nodes in an export whose name or type contains the query (case-insensitive). Returns [{id,name,type,bbox}] to feed into figma_bridge_read_node.",
    inputSchema: z.object({
      name: z.string().min(5),
      query: z.string().min(1),
      limit: z.number().int().positive().max(500).optional().default(50),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(50_000_000)
        .optional()
        .default(20_000_000),
    }),
  },
  async ({ name, query, limit, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const hits = searchNodes(asRoots(res.data.roots), query, limit);
    return jsonText({ count: hits.length, nodes: hits });
  },
);

server.registerTool(
  "figma_bridge_get_raster",
  {
    description:
      "Fetch ONE base64 raster from an export by key (a node id or an image hash) from the `rasters` map, so heavy PNG/image bytes stay out of node reads until needed.",
    inputSchema: z.object({
      name: z.string().min(5),
      key: z.string().min(1).describe("rasters key: node id or image hash"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(50_000_000)
        .optional()
        .default(30_000_000),
    }),
  },
  async ({ name, key, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const rasters = (res.data.rasters ?? {}) as Record<string, unknown>;
    const b64 = rasters[key];
    if (typeof b64 !== "string") {
      return {
        ...jsonText({
          error: "raster_not_found",
          key,
          available: Object.keys(rasters),
        }),
        isError: true,
      };
    }
    return jsonText({ key, base64: b64 });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
