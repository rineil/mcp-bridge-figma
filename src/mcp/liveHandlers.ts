/**
 * Live channel, MCP side: owns the command registry and the promise behind each
 * in-flight tool call, and serves the plugin's POST /poll and POST /result.
 *
 * Lives in the MCP process on purpose — the embedded bridge shares this module
 * scope with the tool handlers, so the queue is a plain in-memory object rather
 * than IPC. Run the standalone `pnpm bridge` instead and the live tools have no
 * server to talk to; that case is detected up front and reported, not hung on.
 *
 * Everything written back by the plugin is persisted through the normal export
 * path, so a live capture produces an ordinary export file and every existing
 * read tool (outline / read_node / get_raster / diff_exports) works on it
 * unchanged.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleExport,
  readBody,
  type LiveHandlers,
} from "../shared/bridgeCore.js";
import {
  LIVE_TUNING,
  LiveRegistry,
  classifyLiveness,
  type LiveOp,
  type LiveParams,
} from "../shared/liveChannel.js";

export type LiveOutcome =
  | { ok: true; basename: string; bytes: number; meta: Record<string, unknown> }
  | { ok: false; code: string; message: string; detail?: unknown };

type Waiter = {
  resolve: (o: LiveOutcome) => void;
  timer: NodeJS.Timeout;
};

type ParkedPoll = {
  sessionId: string;
  res: ServerResponse;
  timer: NodeJS.Timeout;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export class LiveChannel implements LiveHandlers {
  private readonly registry = new LiveRegistry();
  private readonly waiters = new Map<string, Waiter>();
  private parked: ParkedPoll[] = [];
  private readonly exportDir: string;
  private readonly log: (m: string) => void;
  /** Distinguishes ids across restarts so a stale plugin cannot match a new id. */
  private readonly procNonce = randomBytes(4).toString("hex");

  constructor(exportDir: string, log: (m: string) => void) {
    this.exportDir = exportDir;
    this.log = log;
    const sweeper = setInterval(() => this.sweep(), 2_000);
    // Never hold the MCP process open just to sweep an empty queue.
    sweeper.unref?.();
  }

  private now(): number {
    return Date.now();
  }

  private sweep(): void {
    const report = this.registry.sweep(this.now());
    for (const f of report.failed) {
      this.settle(f.id, {
        ok: false,
        code: f.code,
        message:
          f.code === "session_lost"
            ? "The Figma plugin panel closed before it answered. Reopen the Reform MCP Bridge panel in the file you want to read."
            : "The Figma plugin did not answer in time. It may be busy on a large selection, or its tab is throttled in the background.",
      });
    }
  }

  private settle(id: string, outcome: LiveOutcome): void {
    const w = this.waiters.get(id);
    if (!w) {
      return;
    }
    this.waiters.delete(id);
    clearTimeout(w.timer);
    w.resolve(outcome);
  }

  /** Deliver to any poll parked for this session, so a command is not held for POLL_HOLD_MS. */
  private wake(sessionId: string): void {
    const still: ParkedPoll[] = [];
    for (const p of this.parked) {
      if (p.sessionId !== sessionId) {
        still.push(p);
        continue;
      }
      const commands = this.registry.lease(p.sessionId, this.now());
      if (commands.length === 0) {
        still.push(p);
        continue;
      }
      clearTimeout(p.timer);
      // sessionId MUST ride along: a first poll that parks before any command
      // exists has not learned its id yet, and without it the plugin posts a
      // result the registry rejects as wrong_session — the command then sits
      // until its lease expires and gets handed out a second time.
      json(p.res, 200, { ok: true, sessionId: p.sessionId, commands });
    }
    this.parked = still;
  }

  describe(): unknown {
    const st = this.registry.status(this.now());
    return {
      sessions: st.sessions.map((s) => ({
        fileName: s.fileName,
        pageName: s.pageName,
        liveness: s.liveness,
        lastPollAgoMs: s.lastPollAgoMs,
      })),
      queued: st.queued,
      inflight: st.inflight,
    };
  }

  status(): Record<string, unknown> {
    const st = this.registry.status(this.now());
    return {
      connected: st.sessions.some((s) => s.liveness !== "dead"),
      sessions: st.sessions.map((s) => ({
        fileKey: s.fileKey,
        fileName: s.fileName,
        pageName: s.pageName,
        selectionCount: s.selectionCount,
        pluginVersion: s.pluginVersion,
        liveness: s.liveness,
        lastPollAgoMs: s.lastPollAgoMs,
      })),
      queued: st.queued,
      inflight: st.inflight,
      tuning: {
        pollHoldMs: LIVE_TUNING.POLL_HOLD_MS,
        liveMs: LIVE_TUNING.LIVE_MS,
        degradedMs: LIVE_TUNING.DEGRADED_MS,
      },
    };
  }

  /** Enqueue a command and wait for the plugin to answer it. */
  request(
    op: LiveOp,
    params: LiveParams,
    expectFileKey?: string | null,
  ): Promise<LiveOutcome> {
    const id = `${this.procNonce}-${randomBytes(8).toString("hex")}`;
    const enq = this.registry.enqueue(
      { id, op, params, enqueuedAt: this.now() },
      this.now(),
      expectFileKey,
    );
    if (!enq.ok) {
      return Promise.resolve({
        ok: false,
        code: enq.code,
        message: EXPLAIN[enq.code],
        detail: enq.detail,
      });
    }
    const lease = params.includeRaster
      ? LIVE_TUNING.LEASE_RASTER_MS
      : LIVE_TUNING.LEASE_MS;
    return new Promise<LiveOutcome>((resolve) => {
      // Tool timeout outlives the lease, so the sweeper produces the precise
      // reason (lease_expired / session_lost) before this blunt fallback fires.
      const timer = setTimeout(() => {
        this.registry.cancel(id);
        this.waiters.delete(id);
        resolve({
          ok: false,
          code: "timeout",
          message:
            "No answer from the Figma plugin in time. Check that the Reform MCP Bridge panel is still open.",
        });
      }, lease + LIVE_TUNING.TOOL_GRACE_MS);
      timer.unref?.();
      this.waiters.set(id, { resolve, timer });
      this.wake(enq.sessionId);
    });
  }

  async handlePoll(
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes: number,
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req, maxBytes)) as Record<
        string,
        unknown
      >;
    } catch (e) {
      json(res, 400, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const ident = {
      fileKey: (body.fileKey as string | null) ?? null,
      fileName: String(body.fileName ?? ""),
      pageId: String(body.pageId ?? ""),
      pageName: String(body.pageName ?? ""),
      selectionCount: Number(body.selectionCount ?? 0),
    };
    let sessionId =
      typeof body.sessionId === "string" ? body.sessionId : undefined;

    if (!sessionId || !this.registry.touch(sessionId, ident, this.now())) {
      sessionId = `s-${randomBytes(6).toString("hex")}`;
      this.registry.openSession(
        { ...ident, pluginVersion: String(body.pluginVersion ?? "?") },
        sessionId,
        this.now(),
      );
      this.log(`live: panel connected (${ident.fileName} / ${ident.pageName})`);
    }

    const commands = this.registry.lease(sessionId, this.now());
    if (commands.length > 0) {
      json(res, 200, { ok: true, sessionId, commands });
      return;
    }

    // Park briefly so an immediately-following tool call is picked up without
    // waiting a whole poll cycle. ALWAYS answers 200 with a body: the sandbox
    // FetchResponse has no `.body`, and `res.json()` on a 204 throws, which
    // would kill the plugin's loop on its first idle tick.
    const parkedFor = sessionId;
    const timer = setTimeout(() => {
      this.parked = this.parked.filter((p) => p.res !== res);
      json(res, 200, { ok: true, sessionId: parkedFor, commands: [] });
    }, LIVE_TUNING.POLL_HOLD_MS);
    timer.unref?.();
    this.parked.push({ sessionId: parkedFor, res, timer });
    res.on("close", () => {
      clearTimeout(timer);
      this.parked = this.parked.filter((p) => p.res !== res);
    });
  }

  /**
   * Serve a live request forwarded by another MCP process. Identical to what a
   * local tool call does — the queue and the panel do not care which process
   * asked, only that exactly one of them owns the socket.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req, 64 * 1024)) as Record<
        string,
        unknown
      >;
    } catch (e) {
      json(res, 400, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (body.op === "status") {
      json(res, 200, { ok: true, status: this.status() });
      return;
    }
    const params = (body.params ?? {}) as LiveParams;
    const outcome = await this.request(
      (body.op as LiveOp) ?? "selection",
      {
        phase: (params.phase ?? 2) as 1 | 2 | 3,
        scope: params.scope === "page" ? "page" : "selection",
        includeRaster: Boolean(params.includeRaster),
        assetFormats: Array.isArray(params.assetFormats)
          ? params.assetFormats
          : undefined,
      },
      (body.expectFileKey as string | undefined) ?? undefined,
    );
    json(res, 200, { ok: true, outcome });
  }

  async handleResult(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, LIVE_TUNING.RESULT_MAX_BYTES);
    } catch (e) {
      json(res, 413, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      json(res, 400, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const sessionId = String(body.sessionId ?? "");
    const requestId = String(body.requestId ?? "");
    const verdict = this.registry.accept(sessionId, requestId);
    if (verdict !== "ok") {
      // Late or duplicate: acknowledge so the plugin stops retrying, but change
      // nothing. A result that outlived its request must never resolve anything.
      json(res, 200, { ok: true, ignored: verdict });
      return;
    }

    if (body.ok === false) {
      this.settle(requestId, {
        ok: false,
        code: "plugin_error",
        message: String(body.error ?? "the plugin could not run that command"),
      });
      json(res, 200, { ok: true });
      return;
    }

    try {
      const payloadText = JSON.stringify(body.payload ?? {});
      const { path, bytes } = await handleExport(payloadText, this.exportDir);
      const basename = path.split("/").pop() ?? "";
      const meta =
        ((body.payload as Record<string, unknown> | undefined)?.meta as Record<
          string,
          unknown
        >) ?? {};
      this.settle(requestId, { ok: true, basename, bytes, meta });
      json(res, 200, { ok: true, saved: basename, bytes });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.settle(requestId, { ok: false, code: "persist_failed", message });
      json(res, 500, { ok: false, error: message });
    }
  }
}

const EXPLAIN: Record<string, string> = {
  no_session:
    "No Figma plugin panel is polling. Open the file in Figma and run Plugins > Development > Reform MCP Bridge, then retry. Figma cannot be woken remotely — the panel must stay open.",
  ambiguous_session:
    "More than one Figma panel is connected, so it is not clear which file to read. Close the extra panel, or pass fileKey to pick one.",
  file_mismatch:
    "The connected panel is on a different Figma file than the one requested.",
  queue_full:
    "Too many live requests are already queued for the plugin. Wait for them to finish.",
};

export { classifyLiveness };
