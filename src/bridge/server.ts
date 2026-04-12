/**
 * Local HTTP bridge: receives JSON from the Figma plugin and persists files for MCP tools.
 * Default listen: localhost:3845 — POST /export, GET /health.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveExportDir } from "../shared/exportPaths.js";

const PORT = Number(process.env.BRIDGE_PORT ?? "3845");
const HOST = process.env.BRIDGE_HOST ?? "localhost";
const exportDir = resolveExportDir();

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function slugFileKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "file";
}

/** Figma often omits `fileKey` (draft / local / some contexts); use document name as filename prefix. */
function exportFilenamePrefix(meta: {
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

async function handleExport(
  body: string,
): Promise<{ path: string; bytes: number }> {
  const data = JSON.parse(body) as {
    meta?: {
      fileKey?: string | null;
      fileName?: string;
      exportedAt?: string;
    };
  };
  const fileKey = exportFilenamePrefix(data.meta ?? {});
  const stamp = String(
    data.meta?.exportedAt ?? new Date().toISOString(),
  ).replace(/[:.]/g, "-");
  const name = `${fileKey}_${stamp}.json`;
  const full = join(exportDir, name);
  await mkdir(exportDir, { recursive: true });
  const buf = Buffer.byteLength(body, "utf8");
  await writeFile(full, body, "utf8");
  return { path: full, bytes: buf };
}

async function onRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, exportDir, port: PORT }));
    return;
  }
  if (req.method === "POST" && req.url === "/export") {
    try {
      const raw = await readBody(req);
      const { path, bytes } = await handleExport(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: path, bytes }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
}

createServer((req, res) => {
  void onRequest(req, res);
}).listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[figma-bridge] http://${HOST}:${PORT}  exportDir=${exportDir}`);
});
