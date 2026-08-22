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
  componentInventory,
  diffTrees,
  findNodeById,
  limitDepth,
  outline,
  searchNodes,
} from "../shared/exportNodes.js";
import { sniffImageMime } from "../shared/raster.js";
import { codegenNode } from "../shared/codegen.js";
import {
  createBridgeServer,
  loadOrCreateToken,
} from "../shared/bridgeCore.js";
import { LiveChannel, type LiveOutcome } from "./liveHandlers.js";
import type { LiveOp } from "../shared/liveChannel.js";

const exportDir = resolveExportDir();

// 3846, not 3845: Figma's own Dev Mode MCP server listens on 3845, and someone
// reaching for this tool is exactly the person likely to have that running.
const DEFAULT_BRIDGE_PORT = 3846;
/** How often a server that lost the port race retries binding it. */
const RETRY_MS = 5_000;

/** Set when the embedded HTTP server could not start; live tools report it verbatim. */
const liveState: { unavailable: string | null } = {
  unavailable: "the embedded bridge has not started yet",
};

const live = new LiveChannel(exportDir, (m) =>
  process.stderr.write(`[figma-bridge] ${m}\n`),
);

const bridgeCfg = {
  port: Number(process.env.BRIDGE_PORT ?? String(DEFAULT_BRIDGE_PORT)),
  host: process.env.BRIDGE_HOST ?? "localhost",
  maxBytes: Number(process.env.BRIDGE_MAX_BYTES ?? String(64 * 1024 * 1024)),
  token: loadOrCreateToken(exportDir),
};

/**
 * Only one process can bind the bridge port, but every MCP client spawns its
 * own server, so the live channel would otherwise work in whichever client
 * happened to start first — with no way for the user to tell which. The losers
 * forward to the winner over the same token-gated HTTP the plugin uses.
 */
async function proxyLive(
  op: "status" | LiveOp,
  params?: {
    phase: 1 | 2 | 3;
    scope: "selection" | "page";
    includeRaster: boolean;
    assetFormats?: Array<"svg" | "png" | "jpg" | "pdf">;
    assetMode?: "frame" | "icons";
  },
  expectFileKey?: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const url = `http://${bridgeCfg.host}:${bridgeCfg.port}/live/request`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Token": bridgeCfg.token,
      },
      body: JSON.stringify({ op, params, expectFileKey }),
      // Outlast the remote tool timeout (lease + grace) so the far side reports
      // the precise reason instead of this end guessing.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { ok: false, error: `bridge returned ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const server = new McpServer(
  { name: "mcp-bridge-figma", version: "0.9.0" },
  { capabilities: { tools: {} } },
);

type LoadResult =
  // `name` is the resolved basename, so callers that passed "latest" can report
  // which file they actually read.
  | { ok: true; name: string; data: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

/** Resolve the special name "latest" to the newest export via the bridge pointer. */
async function resolveBasename(name: string): Promise<string> {
  if (name !== "latest") {
    return name;
  }
  const ptr = (await readFile(join(exportDir, "_latest.txt"), "utf8")).trim();
  if (!ptr) {
    throw new Error("no latest export yet — export something first");
  }
  return ptr;
}

/** Read + parse an export JSON by basename, guarding path, size, and JSON validity. */
async function loadExport(name: string, maxBytes: number): Promise<LoadResult> {
  const safe = assertSafeExportBasename(await resolveBasename(name));
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
      name: safe,
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
  "figma_bridge_diff_exports",
  {
    description:
      'Compare two exports of the same screen and list what changed: [{id,name,type,change:"added"|"removed"|"modified"}]. Use after the design was re-exported to find exactly which nodes moved since you generated code, instead of re-reading the whole file. Compares per-node `hash` (each covers its subtree), so unchanged branches are skipped. `before` defaults to the second-newest export, `after` to "latest".',
    inputSchema: z.object({
      before: z
        .string()
        .min(5)
        .optional()
        .describe('Older export basename, or "latest"'),
      after: z
        .string()
        .min(5)
        .optional()
        .describe('Newer export basename, or "latest" (default)'),
      limit: z.number().int().positive().max(500).optional().default(100),
      maxBytes: z.number().int().positive().optional().default(20_000_000),
    }),
  },
  async ({ before, after, limit, maxBytes }) => {
    let older = before;
    if (!older) {
      // Default to the previous export so "what changed?" works with no args.
      let names: string[] = [];
      try {
        names = (await readdir(exportDir)).filter((n) => n.endsWith(".json"));
      } catch {
        names = [];
      }
      names.sort().reverse();
      older = names[1];
      if (!older) {
        return {
          ...jsonText({
            error: "need_two_exports",
            detail:
              "Only one export is present, so there is nothing to compare against.",
          }),
          isError: true,
        };
      }
    }
    const a = await loadExport(older, maxBytes);
    if (!a.ok) {
      return { ...jsonText(a.error), isError: true };
    }
    const b = await loadExport(after ?? "latest", maxBytes);
    if (!b.ok) {
      return { ...jsonText(b.error), isError: true };
    }
    const aMeta = (a.data.meta ?? {}) as Record<string, unknown>;
    const bMeta = (b.data.meta ?? {}) as Record<string, unknown>;
    const hashed =
      typeof aMeta.contentHash === "string" &&
      typeof bMeta.contentHash === "string";
    if (hashed && aMeta.contentHash === bMeta.contentHash) {
      return jsonText({
        before: a.name,
        after: b.name,
        identical: true,
        changes: [],
      });
    }
    const changes = diffTrees(asRoots(a.data.roots), asRoots(b.data.roots));
    return jsonText({
      before: a.name,
      after: b.name,
      identical: false,
      // Exports predating per-node hashes still diff, just without subtree pruning.
      hashed,
      totalChanges: changes.length,
      truncated: changes.length > limit,
      changes: changes.slice(0, limit),
    });
  },
);

server.registerTool(
  "figma_bridge_read_export",
  {
    description:
      'Read one export JSON by basename (e.g. myfile_2026-04-12T12-00-00-000Z.json), or "latest" for the newest. Path must stay under the export directory.',
    inputSchema: z.object({
      name: z.string().min(5).describe('Basename ending in .json, or "latest"'),
      maxBytes: z.number().int().positive().max(20_000_000).optional().default(4_000_000),
    }),
  },
  async ({ name, maxBytes }) => {
    const safe = assertSafeExportBasename(await resolveBasename(name));
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
            phase2: "Adds a COMPACT resolved token table (variables: referenced-only, default-mode value + cssColor, plus `byMode` [{mode,value,cssColor}] for multi-mode collections e.g. light/dark) with per-paint `tokens`; text per-range styling (text.segments) + fontWeight + CSS-ready cssLineHeight/cssLetterSpacing/cssTextTransform/cssTextDecoration; effect detail; style IDs.",
            phase3: "Adds component/variant/instance metadata + mainComponent refs + per-instance component.overrides; a top-level `components` registry of LOCAL component definitions (read via figma_bridge_read_component; group instances with figma_bridge_list_components). With the plugin's raster checkbox on, also ships PNG renders of each screen plus the bytes behind IMAGE fills.",
            notes: "Pass name:\"latest\" to any read tool to target the newest export. Each node has a ready `css` block + cssColor/cssGradient — apply them directly. imageHash on IMAGE fills is opaque (not a URL): with phase 3 + raster enabled, figma_bridge_get_raster returns an MCP image block (the agent can SEE it) keyed by node id or imageHash. Icons come through as geometry.fillGeometry SVG paths. For large exports, navigate with figma_bridge_export_outline / search_nodes / read_node instead of reading the whole file.",
            verifyGeneratedUI: "When phase 3 ran with raster on, meta.rasterReport.previews lists one rendered PNG per screen ({id,name,width,height}). After generating code from the JSON, call figma_bridge_get_raster with a preview id to SEE the intended design, then compare it against your output and fix what differs — the JSON says what the values are, the render shows what it should look like. meta.rasterReport.skipped explains any image that did not ship, so an absent raster is never mistaken for a design with no images.",
            assets: "Passing assetFormats to figma_bridge_live_capture (or ticking formats in the plugin) exports the nodes the designer marked for Export in Figma. meta.assetReport lists them ({id,name,formats}); fetch one with figma_bridge_get_asset {nodeId,format}: svg returns inline markup to drop into code, png/jpg return an image block. The user's plugin checkboxes are a permission gate — only formats they ticked are produced.",
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
      'Cheap tree-of-contents for an export: meta + pruned node tree (id/name/type/bbox/childCount) with NO fills/effects/text/variables/rasters. Use FIRST to navigate large exports, then read detail with figma_bridge_read_node. Pass name:"latest" for the newest export.',
    inputSchema: z.object({
      name: z.string().min(5).describe('Export basename ending in .json, or "latest"'),
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
    // Return an MCP image block so a multimodal agent can actually SEE the node,
    // plus a small text block with the key + sniffed MIME type.
    const mimeType = sniffImageMime(b64);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ key, mimeType }) },
        { type: "image" as const, data: b64, mimeType },
      ],
    };
  },
);

server.registerTool(
  "figma_bridge_codegen",
  {
    description:
      'Generate a React JSX skeleton for ONE node (by id) from an export, composing the serializer\'s css/layout.css. `framework`: "react-inline" (style={{…}}) or "react-tailwind" (className utilities + arbitrary values). TEXT -> <span> with color/font, vector -> inline <svg>, IMAGE fill -> <img data-raster=…> (fetch bytes via figma_bridge_get_raster). A deterministic scaffold to iterate on, not final code. Accepts name:"latest".',
    inputSchema: z.object({
      name: z
        .string()
        .min(5)
        .describe('Export basename ending in .json, or "latest"'),
      nodeId: z.string().min(1).describe('Node id, e.g. "12:345"'),
      framework: z
        .enum(["react-inline", "react-tailwind"])
        .optional()
        .default("react-inline"),
      depth: z.number().int().min(0).max(50).optional().default(8),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(20_000_000)
        .optional()
        .default(8_000_000),
    }),
  },
  async ({ name, nodeId, framework, depth, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const node = findNodeById(asRoots(res.data.roots), nodeId);
    if (!node) {
      return { ...jsonText({ error: "node_not_found", nodeId }), isError: true };
    }
    return {
      content: [
        { type: "text" as const, text: codegenNode(node, depth, 0, framework) },
      ],
    };
  },
);

server.registerTool(
  "figma_bridge_list_components",
  {
    description:
      'Inventory of components used in an export: groups INSTANCE nodes by their main component → [{id,name,key,remote,count,instanceIds}] sorted by usage. Use to recognize repeated components ("Button x14") and build a reusable library instead of duplicated markup. Requires phase 3. Accepts name:"latest".',
    inputSchema: z.object({
      name: z
        .string()
        .min(5)
        .describe('Export basename ending in .json, or "latest"'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(50_000_000)
        .optional()
        .default(20_000_000),
    }),
  },
  async ({ name, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const registry = (res.data.components ?? {}) as Record<string, unknown>;
    const components = componentInventory(asRoots(res.data.roots)).map((c) => ({
      ...c,
      // A canonical definition is available via figma_bridge_read_component.
      hasDefinition: Object.prototype.hasOwnProperty.call(registry, c.id),
    }));
    return jsonText({ count: components.length, components });
  },
);

server.registerTool(
  "figma_bridge_read_component",
  {
    description:
      'Read a component DEFINITION subtree from an export by its main-component id (from figma_bridge_list_components, or component.mainComponent.id). The canonical, deduplicated definition — instances carry component.overrides for per-instance diffs. Registry is built at phase 3 for LOCAL components. Accepts name:"latest".',
    inputSchema: z.object({
      name: z
        .string()
        .min(5)
        .describe('Export basename ending in .json, or "latest"'),
      componentId: z.string().min(1).describe('Main component id, e.g. "12:3"'),
      depth: z.number().int().min(0).max(50).optional(),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(20_000_000)
        .optional()
        .default(8_000_000),
    }),
  },
  async ({ name, componentId, depth, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const components = (res.data.components ?? {}) as Record<string, unknown>;
    const def = components[componentId];
    if (def === undefined) {
      return {
        ...jsonText({
          error: "component_not_found",
          componentId,
          available: Object.keys(components),
          hint: "The registry is built at phase 3 for LOCAL components only.",
        }),
        isError: true,
      };
    }
    const out =
      typeof depth === "number" && def && typeof def === "object"
        ? limitDepth(def as Record<string, unknown>, depth)
        : def;
    return jsonText(out);
  },
);

server.registerTool(
  "figma_bridge_live_status",
  {
    description:
      "Check whether a Figma plugin panel is connected RIGHT NOW and which file/page it is on. Cheap, no round-trip to Figma. Call this before figma_bridge_live_capture so you can tell the user to open the panel instead of waiting on a timeout. `connected:false` means nobody is listening — Figma cannot be woken remotely, a human must open the plugin.",
    inputSchema: z.object({}),
  },
  async () => {
    if (!liveState.unavailable) {
      return jsonText(live.status());
    }
    const proxied = await proxyLive("status");
    if (!proxied.ok) {
      return jsonText({
        connected: false,
        liveChannel: "unavailable",
        reason: liveState.unavailable,
        proxyError: proxied.error,
      });
    }
    return jsonText({
      ...(proxied.data.status as Record<string, unknown>),
      servedBy: "another MCP process that owns the bridge port",
    });
  },
);

server.registerTool(
  "figma_bridge_live_capture",
  {
    description:
      "Pull a FRESH export straight from the Figma plugin panel that is open right now, with no manual export step, and save it like any other export. Returns the new basename — then read it with figma_bridge_export_outline / read_node / get_raster, or compare it to the previous one with figma_bridge_diff_exports to see what the designer changed. Prefer this over reading a stale file when the panel is connected; requires the panel to be open (check figma_bridge_live_status first). `scope:\"selection\"` captures what the designer has selected; `\"page\"` captures the whole page.",
    inputSchema: z.object({
      scope: z.enum(["selection", "page"]).optional().default("selection"),
      phase: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .optional()
        .default(2)
        .describe("1 layout, 2 +tokens/text detail, 3 +components/raster"),
      includeRaster: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Phase 3 only: also render a PNG per screen so you can SEE the design. Slower.",
        ),
      assetFormats: z
        .array(z.enum(["svg", "png", "jpg", "pdf"]))
        .optional()
        .describe(
          "Also export assets in these formats, e.g. [\"svg\"]. Listed in meta.assetReport; fetch one with figma_bridge_get_asset. Omit to skip. Gated by the user's plugin checkboxes.",
        ),
      assetMode: z
        .enum(["frame", "icons"])
        .optional()
        .default("icons")
        .describe(
          '"icons" (default): auto-detect icons inside the selection — designer-marked nodes, vectors, small icon-font glyph containers. "frame": export each selected root itself as one asset (e.g. one big illustration).',
        ),
      fileKey: z
        .string()
        .optional()
        .describe("Only act if the connected panel is on this Figma file."),
    }),
  },
  async ({ scope, phase, includeRaster, assetFormats, assetMode, fileKey }) => {
    const op = includeRaster ? "screenshot" : "selection";
    const params = { phase, scope, includeRaster, assetFormats, assetMode };
    let out: LiveOutcome;
    if (liveState.unavailable) {
      const proxied = await proxyLive(op, params, fileKey);
      if (!proxied.ok) {
        return {
          ...jsonText({
            error: "live_unavailable",
            reason: liveState.unavailable,
            proxyError: proxied.error,
            hint: "No process is serving the bridge port. Make sure an MCP client is running with the embedded bridge.",
          }),
          isError: true,
        };
      }
      out = proxied.data.outcome as LiveOutcome;
    } else {
      out = await live.request(op, params, fileKey);
    }
    if (!out.ok) {
      return {
        ...jsonText({ error: out.code, message: out.message, detail: out.detail }),
        isError: true,
      };
    }
    const assetReport = (out.meta as Record<string, unknown> | undefined)
      ?.assetReport as { count?: number } | undefined;
    return jsonText({
      saved: out.basename,
      bytes: out.bytes,
      meta: out.meta,
      next:
        assetReport && (assetReport.count ?? 0) > 0
          ? 'meta.assetReport lists exported assets — fetch one with figma_bridge_get_asset {nodeId, format}. Also read the export via figma_bridge_export_outline {name:"latest"}.'
          : 'Read it with figma_bridge_export_outline {name:"latest"}, or diff it against the previous export with figma_bridge_diff_exports.',
    });
  },
);

server.registerTool(
  "figma_bridge_get_asset",
  {
    description:
      "Fetch ONE exported asset (icon/image) from an export by node id and format. `svg` returns inline SVG markup to drop straight into code; `png`/`jpg` return an image block you can SEE. Assets come from nodes the designer marked for Export in Figma — list them via meta.assetReport (populated when a capture/export requested assetFormats). Accepts name:\"latest\".",
    inputSchema: z.object({
      name: z.string().min(5).describe('Export basename, or "latest"'),
      nodeId: z.string().min(1).describe("Asset node id, e.g. 12:345"),
      format: z.enum(["svg", "png", "jpg", "pdf"]).default("svg"),
      maxBytes: z.number().int().positive().optional().default(20_000_000),
    }),
  },
  async ({ name, nodeId, format, maxBytes }) => {
    const res = await loadExport(name, maxBytes);
    if (!res.ok) {
      return { ...jsonText(res.error), isError: true };
    }
    const assets = (res.data.assets ?? []) as Array<{
      id: string;
      name: string;
      formats: string[];
      svg?: string;
      rasterKeys?: Record<string, string>;
    }>;
    // Duplicate icons are stored once; other node ids with identical bytes map
    // to the canonical asset via assetAliases. Resolve before failing so an
    // agent can ask about ANY node it saw in the tree.
    const aliases = (res.data.assetAliases ?? {}) as Record<string, string>;
    const canonicalId = aliases[nodeId] ?? nodeId;
    const asset = assets.find((a) => a.id === canonicalId);
    if (!asset) {
      return {
        ...jsonText({
          error: "asset_not_found",
          nodeId,
          available: assets.map((a) => ({
            id: a.id,
            name: a.name,
            formats: a.formats,
          })),
        }),
        isError: true,
      };
    }
    if (format === "svg") {
      if (typeof asset.svg !== "string") {
        return {
          ...jsonText({
            error: "format_not_exported",
            nodeId,
            have: asset.formats,
          }),
          isError: true,
        };
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ nodeId, format: "svg", name: asset.name }) },
          { type: "text" as const, text: asset.svg },
        ],
      };
    }
    const key = asset.rasterKeys?.[format];
    const rasters = (res.data.rasters ?? {}) as Record<string, unknown>;
    const b64 = key ? rasters[key] : undefined;
    if (typeof b64 !== "string") {
      return {
        ...jsonText({ error: "format_not_exported", nodeId, have: asset.formats }),
        isError: true,
      };
    }
    // PDF has no image block; hand back the base64 with its type instead.
    if (format === "pdf") {
      return jsonText({ nodeId, format, name: asset.name, base64: b64, mimeType: "application/pdf" });
    }
    const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ nodeId, format, name: asset.name, mimeType }) },
        { type: "image" as const, data: b64, mimeType },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Embed the local ingest HTTP server so `node dist-mcp/server.js` is launchable
// on its own. Opt out with BRIDGE_EMBED=0 when running `pnpm bridge` separately
// — but note the live tools only work through the EMBEDDED server, since the
// command queue lives in this process's memory.
// CRITICAL: all logging goes to STDERR — stdout is the MCP JSON-RPC stream.
if (process.env.BRIDGE_EMBED !== "0") {
  const elog = (m: string): void => {
    process.stderr.write(`[figma-bridge] ${m}\n`);
  };
  // Same values the proxy path dials, so a listener and a forwarder can never
  // disagree about where the bridge is or which token opens it.
  const { port, host, maxBytes, token } = bridgeCfg;
  const bridge = createBridgeServer({ exportDir, token, maxBytes, live });
  let announced = false;

  bridge.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      // Record WHY, so a live tool fails in milliseconds with the real cause
      // instead of enqueueing into a server that never started and timing out
      // 25s later blaming a closed Figma panel.
      liveState.unavailable = `port ${port} is in use by another process, so the live channel has no HTTP server here. Retrying every ${RETRY_MS / 1000}s — it recovers on its own once that process exits.`;
      if (!announced) {
        elog(`port ${port} in use — live disabled, retrying every ${RETRY_MS / 1000}s.`);
        announced = true;
      }
      // Several MCP clients each spawn this server and race for the port; the
      // losers used to stay dead forever, so live stayed broken even after the
      // winner exited. Keep trying instead of requiring a manual restart.
      const t = setTimeout(tryListen, RETRY_MS);
      t.unref?.();
    } else {
      liveState.unavailable = `embedded ingest failed: ${e.message}`;
      elog(`embedded ingest error: ${e.message}`);
    }
  });

  // Registered once, not per attempt: listen(port, host, cb) appends another
  // 'listening' handler each call, so retrying would fire every accumulated
  // callback on the eventual success.
  bridge.on("listening", () => {
    liveState.unavailable = null;
    announced = false;
    elog(`embedded ingest on http://${host}:${port}  exportDir=${exportDir}`);
    elog(`token: ${token} — paste into the plugin's "Bridge token" field.`);
  });

  function tryListen(): void {
    if (bridge.listening) {
      return;
    }
    bridge.listen(port, host);
  }
  tryListen();
} else {
  liveState.unavailable =
    "BRIDGE_EMBED=0, so this process has no HTTP server. The live channel requires the embedded bridge; remove BRIDGE_EMBED=0 from the MCP server env and restart.";
}
