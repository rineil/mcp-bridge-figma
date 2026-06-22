/**
 * Local HTTP bridge: receives JSON from the Figma plugin and persists files for MCP tools.
 * Default listen: localhost:3845 — POST /export (token-gated), GET /health.
 *
 * Security: POST /export requires a shared token (X-Bridge-Token header) so a
 * drive-by web page or other local process cannot write attacker-controlled
 * JSON into the export dir (which an AI agent later reads). The token comes from
 * BRIDGE_TOKEN, else a stable random token stored in <exportDir>/.bridge-token.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolveExportDir } from "../shared/exportPaths.js";

const PORT = Number(process.env.BRIDGE_PORT ?? "3845");
const HOST = process.env.BRIDGE_HOST ?? "localhost";
const MAX_BYTES = Number(
  process.env.BRIDGE_MAX_BYTES ?? String(64 * 1024 * 1024),
);
const exportDir = resolveExportDir();
const TOKEN = loadOrCreateToken();

/** Shared secret for POST /export. BRIDGE_TOKEN, else a stable random token file. */
function loadOrCreateToken(): string {
  const fromEnv = process.env.BRIDGE_TOKEN;
  if (fromEnv && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  const tokenPath = join(exportDir, ".bridge-token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    /* not created yet */
  }
  const tok = randomBytes(24).toString("hex");
  try {
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(tokenPath, tok, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* fall back to an in-memory token for this run */
  }
  return tok;
}

function tokenOk(req: IncomingMessage): boolean {
  const got = req.headers["x-bridge-token"];
  if (typeof got !== "string") {
    return false;
  }
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cors(res: ServerResponse): void {
  // ACAO stays permissive for the plugin to read the JSON response; the token
  // (not CORS) is the actual write gate, so this is not a write vector.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const onData = (c: Buffer | string): void => {
      if (done) {
        return;
      }
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += b.length;
      if (total > MAX_BYTES) {
        done = true;
        req.removeListener("data", onData);
        req.pause(); // stop buffering; the 413 response is sent by the caller
        reject(new Error(`request body too large (> ${MAX_BYTES} bytes)`));
        return;
      }
      chunks.push(b);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
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
    meta?: { fileKey?: string | null; fileName?: string };
  };
  const prefix = exportFilenamePrefix(data.meta ?? {});
  // Server-side timestamp — do NOT trust client meta.exportedAt for the filename.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(exportDir, { recursive: true });
  const bytes = Buffer.byteLength(body, "utf8");
  // Never overwrite: 'wx' fails if the path exists; add a counter on collision.
  for (let i = 0; ; i++) {
    const name =
      i === 0 ? `${prefix}_${stamp}.json` : `${prefix}_${stamp}_${i}.json`;
    const full = join(exportDir, name);
    try {
      await writeFile(full, body, { encoding: "utf8", flag: "wx" });
      return { path: full, bytes };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw e;
    }
  }
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
    res.end(JSON.stringify({ ok: true, port: PORT }));
    return;
  }
  if (req.method === "POST" && req.url === "/export") {
    if (!tokenOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "unauthorized: missing/invalid X-Bridge-Token",
        }),
      );
      return;
    }
    try {
      const raw = await readBody(req);
      const { path, bytes } = await handleExport(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: path, bytes }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const tooLarge = message.includes("too large");
      // On too-large we stopped reading the body, so close the connection to
      // avoid a leftover unread body corrupting a keep-alive socket.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (tooLarge) {
        headers["Connection"] = "close";
      }
      res.writeHead(tooLarge ? 413 : 400, headers);
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
  // eslint-disable-next-line no-console
  console.log(
    `[figma-bridge] token: ${TOKEN}\n[figma-bridge] paste this into the plugin's "Bridge token" field (stored once via clientStorage).`,
  );
});
