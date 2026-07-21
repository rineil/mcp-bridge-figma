/**
 * State machine for the live channel: MCP tools enqueue a command, the Figma
 * plugin leases it on its next poll, runs it, and posts the result back.
 *
 * Kept free of `node:http` and of timers so the ordering rules below — which are
 * where the real bugs live — can be unit-tested against a fake clock. The HTTP
 * layer owns sockets, and the MCP layer owns the promise per request id; this
 * module owns only *which command is owed to whom, and whether anyone still
 * wants it*.
 *
 * Figma has no background execution: the plugin only polls while its panel is
 * open. "Nobody is listening" is therefore the ordinary state, not an error
 * path, and every operation here is written to fail fast and explain itself
 * rather than let a caller hang.
 */

export type LiveOp = "selection" | "screenshot" | "probe";

export type LiveParams = {
  phase: 1 | 2 | 3;
  scope: "selection" | "page";
  includeRaster: boolean;
};

export type LiveCommand = {
  id: string;
  op: LiveOp;
  params: LiveParams;
  enqueuedAt: number;
  /** sessionId holding the lease, once handed out. */
  leasedTo?: string;
  leaseUntil?: number;
  /** A requeued command is only retried once; the second expiry fails it. */
  attempts: number;
};

export type LiveSessionInit = {
  fileKey: string | null;
  fileName: string;
  pageId: string;
  pageName: string;
  pluginVersion: string;
  selectionCount: number;
};

export type LiveSession = LiveSessionInit & {
  sessionId: string;
  createdAt: number;
  lastPollAt: number;
};

/**
 * `degraded` exists because a backgrounded browser tab has its timers throttled;
 * the panel is still open and will answer, just late. Reporting that as `dead`
 * would send the agent to stale exports for what is a working session.
 */
export type Liveness = "live" | "degraded" | "dead";

export const LIVE_TUNING = {
  /** Server-side hold on an idle poll. Short, because sandbox fetch cannot be aborted. */
  POLL_HOLD_MS: 3_000,
  LEASE_MS: 20_000,
  LEASE_RASTER_MS: 45_000,
  /** Tool timeout = lease + grace, so the lease always expires first. */
  TOOL_GRACE_MS: 5_000,
  LIVE_MS: 15_000,
  DEGRADED_MS: 120_000,
  SESSION_TTL_MS: 1_800_000,
  MAX_QUEUE: 16,
  MAX_INFLIGHT_PER_SESSION: 2,
  RESULT_MAX_BYTES: 8 * 1024 * 1024,
} as const;

export function classifyLiveness(
  lastPollAt: number,
  now: number,
  tuning = LIVE_TUNING,
): Liveness {
  const gap = now - lastPollAt;
  if (gap <= tuning.LIVE_MS) {
    return "live";
  }
  if (gap <= tuning.DEGRADED_MS) {
    return "degraded";
  }
  return "dead";
}

export type EnqueueError =
  | "no_session"
  | "queue_full"
  | "ambiguous_session"
  | "file_mismatch";

export type EnqueueResult =
  | { ok: true; sessionId: string; command: LiveCommand }
  | { ok: false; code: EnqueueError; detail: Record<string, unknown> };

export type AcceptResult = "ok" | "wrong_session" | "unknown_or_expired";

export type SweepReport = {
  requeued: string[];
  failed: Array<{ id: string; code: "lease_expired" | "session_lost" }>;
  droppedSessions: string[];
};

export class LiveRegistry {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly queue: LiveCommand[] = [];
  /**
   * Ids the caller still wants. A command is dispatched only if its id is here,
   * so one that already timed out is never sent to Figma to be executed for
   * nobody.
   */
  private readonly pending = new Set<string>();
  private readonly tuning: typeof LIVE_TUNING;

  constructor(tuning: typeof LIVE_TUNING = LIVE_TUNING) {
    this.tuning = tuning;
  }

  openSession(init: LiveSessionInit, sessionId: string, now: number): LiveSession {
    const s: LiveSession = {
      ...init,
      sessionId,
      createdAt: now,
      lastPollAt: now,
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  /**
   * Refresh identity from the poll body. The plugin re-reads file/page on every
   * poll, so a mid-session file switch shows up here rather than silently
   * answering questions about the wrong document.
   */
  touch(
    sessionId: string,
    ident: Pick<
      LiveSession,
      "fileKey" | "fileName" | "pageId" | "pageName" | "selectionCount"
    >,
    now: number,
  ): LiveSession | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return undefined;
    }
    s.fileKey = ident.fileKey;
    s.fileName = ident.fileName;
    s.pageId = ident.pageId;
    s.pageName = ident.pageName;
    s.selectionCount = ident.selectionCount;
    s.lastPollAt = now;
    return s;
  }

  private liveSessions(now: number): LiveSession[] {
    return [...this.sessions.values()].filter(
      (s) => classifyLiveness(s.lastPollAt, now, this.tuning) !== "dead",
    );
  }

  enqueue(
    cmd: Omit<LiveCommand, "leasedTo" | "leaseUntil" | "attempts">,
    now: number,
    expectFileKey?: string | null,
  ): EnqueueResult {
    let candidates = this.liveSessions(now);
    if (candidates.length === 0) {
      return { ok: false, code: "no_session", detail: {} };
    }
    if (expectFileKey !== undefined && expectFileKey !== null) {
      const matching = candidates.filter((s) => s.fileKey === expectFileKey);
      if (matching.length === 0) {
        return {
          ok: false,
          code: "file_mismatch",
          detail: {
            want: expectFileKey,
            open: candidates.map((s) => ({
              fileKey: s.fileKey,
              fileName: s.fileName,
            })),
          },
        };
      }
      candidates = matching;
    }
    // Two Figma windows both polling would drain one queue nondeterministically,
    // answering truthfully about the wrong file. Refuse rather than guess.
    if (candidates.length > 1) {
      return {
        ok: false,
        code: "ambiguous_session",
        detail: {
          sessions: candidates.map((s) => ({
            sessionId: s.sessionId,
            fileName: s.fileName,
            pageName: s.pageName,
          })),
        },
      };
    }
    if (this.queue.length >= this.tuning.MAX_QUEUE) {
      return {
        ok: false,
        code: "queue_full",
        detail: { queued: this.queue.length },
      };
    }
    const full: LiveCommand = { ...cmd, attempts: 0 };
    // Register interest BEFORE queueing: lease() filters on `pending`, and the
    // reverse order leaves a window where a just-enqueued command looks unwanted.
    this.pending.add(full.id);
    this.queue.push(full);
    return { ok: true, sessionId: candidates[0].sessionId, command: full };
  }

  /** Hand out up to MAX_INFLIGHT_PER_SESSION commands, skipping abandoned ones. */
  lease(sessionId: string, now: number, rasterAware = true): LiveCommand[] {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return [];
    }
    const inflight = this.queue.filter(
      (c) => c.leasedTo === sessionId && (c.leaseUntil ?? 0) > now,
    ).length;
    let budget = this.tuning.MAX_INFLIGHT_PER_SESSION - inflight;
    const out: LiveCommand[] = [];
    for (const c of this.queue) {
      if (budget <= 0) {
        break;
      }
      if (!this.pending.has(c.id)) {
        continue; // caller gave up; sweep() will drop it
      }
      if (c.leasedTo && (c.leaseUntil ?? 0) > now) {
        continue; // already out with someone
      }
      c.leasedTo = sessionId;
      c.leaseUntil =
        now +
        (rasterAware && c.params.includeRaster
          ? this.tuning.LEASE_RASTER_MS
          : this.tuning.LEASE_MS);
      out.push(c);
      budget--;
    }
    return out;
  }

  /**
   * Validate an incoming result. Removing from `pending` here (before the caller
   * resolves its promise) makes a duplicate POST — a plugin retry — a no-op
   * rather than a double-resolve.
   */
  accept(sessionId: string, requestId: string): AcceptResult {
    const idx = this.queue.findIndex((c) => c.id === requestId);
    if (idx < 0 || !this.pending.has(requestId)) {
      return "unknown_or_expired";
    }
    if (this.queue[idx].leasedTo !== sessionId) {
      return "wrong_session";
    }
    this.pending.delete(requestId);
    this.queue.splice(idx, 1);
    return "ok";
  }

  /** Caller stopped waiting (timeout or MCP abort). */
  cancel(requestId: string): void {
    this.pending.delete(requestId);
    const idx = this.queue.findIndex((c) => c.id === requestId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
  }

  sweep(now: number): SweepReport {
    const report: SweepReport = {
      requeued: [],
      failed: [],
      droppedSessions: [],
    };

    for (const [id, s] of this.sessions) {
      if (
        classifyLiveness(s.lastPollAt, now, this.tuning) === "dead" ||
        now - s.createdAt > this.tuning.SESSION_TTL_MS
      ) {
        this.sessions.delete(id);
        report.droppedSessions.push(id);
      }
    }

    // Requeue only if somebody could actually pick the command up. Putting it
    // back with no panel polling just parks it until the caller's timeout,
    // turning "the panel is closed" into a 25s wait instead of an instant,
    // accurate answer.
    const someoneListening = this.liveSessions(now).length > 0;

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const c = this.queue[i];
      if (!this.pending.has(c.id)) {
        this.queue.splice(i, 1); // abandoned by caller
        continue;
      }
      const leaseDead = c.leasedTo && (c.leaseUntil ?? 0) <= now;
      const holderGone = c.leasedTo && !this.sessions.has(c.leasedTo);
      if (!leaseDead && !holderGone) {
        continue;
      }
      // The panel can close between hand-out and result; give it one more shot
      // at a different (or reopened) session before failing the caller.
      if (c.attempts < 1 && someoneListening) {
        c.attempts++;
        c.leasedTo = undefined;
        c.leaseUntil = undefined;
        report.requeued.push(c.id);
        continue;
      }
      this.pending.delete(c.id);
      this.queue.splice(i, 1);
      report.failed.push({
        id: c.id,
        code: holderGone ? "session_lost" : "lease_expired",
      });
    }

    return report;
  }

  status(now: number): {
    sessions: Array<LiveSession & { liveness: Liveness; lastPollAgoMs: number }>;
    queued: number;
    inflight: number;
  } {
    return {
      sessions: [...this.sessions.values()].map((s) => ({
        ...s,
        liveness: classifyLiveness(s.lastPollAt, now, this.tuning),
        lastPollAgoMs: now - s.lastPollAt,
      })),
      queued: this.queue.length,
      inflight: this.queue.filter((c) => c.leasedTo && (c.leaseUntil ?? 0) > now)
        .length,
    };
  }

  /** True while the caller still wants this id — used to drop late results. */
  isPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}
