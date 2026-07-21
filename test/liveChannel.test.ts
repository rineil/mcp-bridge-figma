import { describe, it, expect } from "vitest";
import {
  LIVE_TUNING,
  LiveRegistry,
  classifyLiveness,
  type LiveSessionInit,
} from "../src/shared/liveChannel";

const T0 = 1_000_000;

const ident = (over: Partial<LiveSessionInit> = {}): LiveSessionInit => ({
  fileKey: "FILE1",
  fileName: "DP RENT_BDS",
  pageId: "13:2",
  pageName: "Main Design",
  pluginVersion: "0.8.0",
  selectionCount: 1,
  ...over,
});

const cmd = (id: string, includeRaster = false) => ({
  id,
  op: "selection" as const,
  params: { phase: 2 as const, scope: "selection" as const, includeRaster },
  enqueuedAt: T0,
});

const openOne = (r: LiveRegistry, sid = "S1", over = {}) =>
  r.openSession(ident(over), sid, T0);

describe("classifyLiveness", () => {
  it("tiers on how long ago the panel last polled", () => {
    expect(classifyLiveness(T0, T0)).toBe("live");
    expect(classifyLiveness(T0, T0 + LIVE_TUNING.LIVE_MS)).toBe("live");
    // A backgrounded tab is throttled, not gone — it must not read as dead.
    expect(classifyLiveness(T0, T0 + LIVE_TUNING.LIVE_MS + 1)).toBe("degraded");
    expect(classifyLiveness(T0, T0 + LIVE_TUNING.DEGRADED_MS)).toBe("degraded");
    expect(classifyLiveness(T0, T0 + LIVE_TUNING.DEGRADED_MS + 1)).toBe("dead");
  });
});

describe("enqueue", () => {
  it("refuses when no panel is polling", () => {
    const r = new LiveRegistry();
    const res = r.enqueue(cmd("c1"), T0);
    expect(res).toMatchObject({ ok: false, code: "no_session" });
  });

  it("refuses when the only session went dead", () => {
    const r = new LiveRegistry();
    openOne(r);
    const later = T0 + LIVE_TUNING.DEGRADED_MS + 1;
    expect(r.enqueue(cmd("c1"), later)).toMatchObject({
      ok: false,
      code: "no_session",
    });
  });

  it("refuses rather than guess when two files are open", () => {
    const r = new LiveRegistry();
    openOne(r, "S1", { fileKey: "A", fileName: "Alpha" });
    openOne(r, "S2", { fileKey: "B", fileName: "Beta" });
    const res = r.enqueue(cmd("c1"), T0);
    expect(res).toMatchObject({ ok: false, code: "ambiguous_session" });
  });

  it("disambiguates two sessions by expected fileKey", () => {
    const r = new LiveRegistry();
    openOne(r, "S1", { fileKey: "A" });
    openOne(r, "S2", { fileKey: "B" });
    const res = r.enqueue(cmd("c1"), T0, "B");
    expect(res).toMatchObject({ ok: true, sessionId: "S2" });
  });

  it("reports which files are open when none match", () => {
    const r = new LiveRegistry();
    openOne(r, "S1", { fileKey: "A", fileName: "Alpha" });
    const res = r.enqueue(cmd("c1"), T0, "NOPE");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("file_mismatch");
      expect(res.detail).toMatchObject({ want: "NOPE" });
    }
  });

  it("caps the queue", () => {
    const r = new LiveRegistry();
    openOne(r);
    for (let i = 0; i < LIVE_TUNING.MAX_QUEUE; i++) {
      expect(r.enqueue(cmd(`c${i}`), T0).ok).toBe(true);
    }
    expect(r.enqueue(cmd("overflow"), T0)).toMatchObject({
      ok: false,
      code: "queue_full",
    });
  });
});

describe("lease", () => {
  it("hands out at most MAX_INFLIGHT_PER_SESSION at a time", () => {
    const r = new LiveRegistry();
    openOne(r);
    for (let i = 0; i < 5; i++) {
      r.enqueue(cmd(`c${i}`), T0);
    }
    const first = r.lease("S1", T0);
    expect(first).toHaveLength(LIVE_TUNING.MAX_INFLIGHT_PER_SESSION);
    // Still held, so a second poll gets nothing new.
    expect(r.lease("S1", T0 + 1)).toHaveLength(0);
  });

  it("never dispatches a command the caller already abandoned", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.cancel("c1"); // tool timed out before the panel polled
    expect(r.lease("S1", T0)).toHaveLength(0);
  });

  it("gives a raster command a longer lease", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("plain", false), T0);
    r.enqueue(cmd("raster", true), T0);
    const out = r.lease("S1", T0);
    const plain = out.find((c) => c.id === "plain");
    const raster = out.find((c) => c.id === "raster");
    expect(plain?.leaseUntil).toBe(T0 + LIVE_TUNING.LEASE_MS);
    expect(raster?.leaseUntil).toBe(T0 + LIVE_TUNING.LEASE_RASTER_MS);
  });

  it("returns nothing for an unknown session", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    expect(r.lease("GHOST", T0)).toHaveLength(0);
  });
});

describe("accept", () => {
  it("accepts a result from the session holding the lease", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.lease("S1", T0);
    expect(r.accept("S1", "c1")).toBe("ok");
  });

  it("rejects a result from a different session", () => {
    const r = new LiveRegistry();
    openOne(r, "S1", { fileKey: "A" });
    openOne(r, "S2", { fileKey: "B" });
    r.enqueue(cmd("c1"), T0, "A");
    r.lease("S1", T0);
    expect(r.accept("S2", "c1")).toBe("wrong_session");
  });

  it("is idempotent, so a plugin retry cannot double-resolve", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.lease("S1", T0);
    expect(r.accept("S1", "c1")).toBe("ok");
    expect(r.accept("S1", "c1")).toBe("unknown_or_expired");
  });

  it("rejects a result for a command whose caller gave up", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.lease("S1", T0);
    r.cancel("c1");
    expect(r.accept("S1", "c1")).toBe("unknown_or_expired");
  });
});

describe("sweep", () => {
  it("requeues once when a lease expires, then fails it", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.lease("S1", T0);

    const expiry = T0 + LIVE_TUNING.LEASE_MS + 1;
    // Keep the session alive so this is a lease expiry, not a lost session.
    r.touch("S1", ident(), expiry);
    const first = r.sweep(expiry);
    expect(first.requeued).toEqual(["c1"]);
    expect(r.isPending("c1")).toBe(true);

    r.lease("S1", expiry);
    const expiry2 = expiry + LIVE_TUNING.LEASE_MS + 1;
    r.touch("S1", ident(), expiry2);
    const second = r.sweep(expiry2);
    expect(second.failed).toEqual([{ id: "c1", code: "lease_expired" }]);
    expect(r.isPending("c1")).toBe(false);
  });

  it("fails a command immediately when the last panel is gone", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.lease("S1", T0);
    const dead = T0 + LIVE_TUNING.DEGRADED_MS + 1;
    const rep = r.sweep(dead);
    expect(rep.droppedSessions).toEqual(["S1"]);
    // No panel left to retry against, so requeueing would only stall the caller.
    expect(rep.requeued).toEqual([]);
    expect(rep.failed).toEqual([{ id: "c1", code: "session_lost" }]);
    expect(r.isPending("c1")).toBe(false);
  });

  it("hands the command to a surviving panel instead of failing it", () => {
    const r = new LiveRegistry();
    openOne(r, "S1", { fileKey: "A" });
    r.enqueue(cmd("c1"), T0, "A");
    r.lease("S1", T0);
    // S2 opens later and is still polling when S1 dies.
    const dead = T0 + LIVE_TUNING.DEGRADED_MS + 1;
    r.openSession(ident({ fileKey: "B" }), "S2", dead);
    const rep = r.sweep(dead);
    expect(rep.droppedSessions).toEqual(["S1"]);
    expect(rep.requeued).toEqual(["c1"]);
    expect(r.isPending("c1")).toBe(true);
  });

  it("clears commands whose caller stopped waiting", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.cancel("c1");
    r.sweep(T0 + 1);
    expect(r.status(T0 + 1).queued).toBe(0);
  });

  it("expires a session past its TTL even while it keeps polling", () => {
    const r = new LiveRegistry();
    openOne(r);
    const late = T0 + LIVE_TUNING.SESSION_TTL_MS + 1;
    r.touch("S1", ident(), late); // still polling, but too old
    expect(r.sweep(late).droppedSessions).toEqual(["S1"]);
  });
});

describe("touch", () => {
  it("picks up a mid-session file switch", () => {
    const r = new LiveRegistry();
    openOne(r, "S1", { fileKey: "A", fileName: "Alpha" });
    const s = r.touch(
      "S1",
      {
        fileKey: "B",
        fileName: "Beta",
        pageId: "9:9",
        pageName: "Other",
        selectionCount: 3,
      },
      T0 + 100,
    );
    expect(s).toMatchObject({ fileKey: "B", fileName: "Beta" });
    // The old file no longer resolves, so a command bound to it is refused.
    expect(r.enqueue(cmd("c1"), T0 + 100, "A")).toMatchObject({
      ok: false,
      code: "file_mismatch",
    });
  });

  it("returns undefined for an unknown session", () => {
    const r = new LiveRegistry();
    expect(
      r.touch(
        "GHOST",
        {
          fileKey: null,
          fileName: "x",
          pageId: "1",
          pageName: "p",
          selectionCount: 0,
        },
        T0,
      ),
    ).toBeUndefined();
  });
});

describe("status", () => {
  it("reports liveness and staleness for the agent to reason about", () => {
    const r = new LiveRegistry();
    openOne(r);
    r.enqueue(cmd("c1"), T0);
    r.lease("S1", T0);
    const st = r.status(T0 + 5_000);
    expect(st.queued).toBe(1);
    expect(st.inflight).toBe(1);
    expect(st.sessions[0]).toMatchObject({
      liveness: "live",
      lastPollAgoMs: 5_000,
    });
  });
});
