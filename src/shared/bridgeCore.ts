/**
 * Reusable local-ingest HTTP server: receives JSON from the Figma plugin and
 * persists files for the MCP tools. Shared by the standalone bridge and the MCP
 * server (embedded). IMPORTANT: this module never writes to stdout — the caller
 * owns logging — so it is safe to embed inside the MCP stdio process.
 *
 * Security: POST /export requires a shared token (X-Bridge-Token header) so a
 * drive-by web page or other local process cannot write attacker-controlled
 * JSON into the export dir. Token comes from BRIDGE_TOKEN, else a stable random
 * token stored in <exportDir>/.bridge-token.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { exportPrefix } from "./exportNaming.js";

/** Shared secret for POST /export. BRIDGE_TOKEN, else a stable random token file. */
export function loadOrCreateToken(exportDir: string): string {
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

export type BridgeOptions = {
  exportDir: string;
  token: string;
  maxBytes: number;
};

function cors(res: ServerResponse): void {
  // ACAO stays permissive for the plugin to read the JSON response; the token
  // (not CORS) is the actual write gate, so this is not a write vector.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");
}

function tokenOk(req: IncomingMessage, token: string): boolean {
  const got = req.headers["x-bridge-token"];
  if (typeof got !== "string") {
    return false;
  }
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
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
      if (total > maxBytes) {
        done = true;
        req.removeListener("data", onData);
        req.pause(); // stop buffering; the 413 response is sent by the caller
        reject(new Error(`request body too large (> ${maxBytes} bytes)`));
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

async function handleExport(
  body: string,
  exportDir: string,
): Promise<{ path: string; bytes: number }> {
  const data = JSON.parse(body) as {
    meta?: { fileKey?: string | null; fileName?: string };
    roots?: Array<{ name?: unknown }>;
  };
  const firstRootName =
    typeof data.roots?.[0]?.name === "string" ? data.roots[0].name : undefined;
  const prefix = exportPrefix(data.meta ?? {}, firstRootName);
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
      // Pointer to the newest export so MCP tools can resolve name:"latest".
      await writeFile(join(exportDir, "_latest.txt"), name, "utf8");
      return { path: full, bytes };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw e;
    }
  }
}

/** Build (but do not start) the ingest HTTP server. The caller calls .listen(). */
export function createBridgeServer(opts: BridgeOptions): Server {
  const { exportDir, token, maxBytes } = opts;
  const onRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/export") {
      if (!tokenOk(req, token)) {
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
        const raw = await readBody(req, maxBytes);
        const { path, bytes } = await handleExport(raw, exportDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, saved: path, bytes }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const tooLarge = message.includes("too large");
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
  };
  return createServer((req, res) => {
    void onRequest(req, res);
  });
}
