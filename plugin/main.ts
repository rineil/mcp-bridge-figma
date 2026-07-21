/// <reference types="@figma/plugin-typings" />

import {
  buildExportPayload,
  PLUGIN_VERSION,
  type ExportPhase,
  type ExportScope,
} from "./serialize";

type ExportMsg = {
  type: "export";
  phase: ExportPhase;
  scope: ExportScope;
  bridgeUrl: string;
  token: string;
  includeRaster: boolean;
};
type PingMsg = { type: "ping"; bridgeUrl: string; token: string };
type LiveMsg = {
  type: "live";
  enabled: boolean;
  bridgeUrl: string;
  token: string;
};
type UiMessage = ExportMsg | PingMsg | LiveMsg;

type LiveCommand = {
  id: string;
  op: string;
  params: { phase: ExportPhase; scope: ExportScope; includeRaster: boolean };
};

/**
 * Live channel: the bridge cannot reach into Figma, so the panel asks it for
 * work. Bumping the generation cancels the running loop — sandbox `fetch` has
 * no `signal` (FetchOptions carries no AbortController), so an in-flight poll
 * cannot be aborted and is instead ignored on arrival.
 *
 * Self-scheduling rather than setInterval: a slow poll must not let ticks stack
 * up behind it.
 */
const liveLoop: { generation: number; running: boolean; sessionId?: string } = {
  generation: 0,
  running: false,
};

function liveStatusToUi(state: string, detail?: string): void {
  figma.ui.postMessage({ type: "liveStatus", state, detail });
}

async function runLiveCommand(
  cmd: LiveCommand,
): Promise<{ ok: true; payload: unknown } | { ok: false; error: string }> {
  try {
    const payload = await buildExportPayload({
      phase: cmd.params.phase,
      scope: cmd.params.scope,
      includeRaster: cmd.params.includeRaster,
    });
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function liveTick(base: string, token: string, gen: number): Promise<void> {
  if (gen !== liveLoop.generation) {
    return;
  }
  let delay = 500;
  try {
    const res = await fetch(`${base}/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify({
        sessionId: liveLoop.sessionId,
        pluginVersion: PLUGIN_VERSION,
        // Re-read identity every poll so the server notices a file/page switch
        // instead of answering confidently about the wrong document.
        fileKey: figma.fileKey ?? null,
        fileName: figma.root.name,
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        selectionCount: figma.currentPage.selection.length,
      }),
    });
    if (gen !== liveLoop.generation) {
      return;
    }
    if (res.status === 401) {
      liveLoop.running = false;
      liveStatusToUi("error", "Token sai — kiểm tra lại Bridge token.");
      return;
    }
    if (!res.ok) {
      liveStatusToUi("retrying", `Bridge trả ${res.status}`);
      delay = 3000;
    } else {
      // The server always sends a JSON body, including when idle: FetchResponse
      // has no `.body` to test and `json()` on an empty 204 would throw here and
      // kill the loop on its first idle tick.
      const data = (await res.json()) as {
        sessionId?: string;
        commands?: LiveCommand[];
      };
      if (data.sessionId) {
        liveLoop.sessionId = data.sessionId;
      }
      const commands = data.commands ?? [];
      liveStatusToUi(commands.length ? "working" : "connected");
      for (const cmd of commands) {
        const out = await runLiveCommand(cmd);
        if (gen !== liveLoop.generation) {
          return;
        }
        await fetch(`${base}/result`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Bridge-Token": token,
          },
          body: JSON.stringify({
            sessionId: liveLoop.sessionId,
            requestId: cmd.id,
            ok: out.ok,
            error: out.ok ? undefined : out.error,
            payload: out.ok ? out.payload : undefined,
          }),
        });
      }
      if (commands.length > 0) {
        liveStatusToUi("connected");
        delay = 0; // more may be queued
      }
    }
  } catch (e) {
    liveStatusToUi("retrying", e instanceof Error ? e.message : String(e));
    delay = 3000;
  }
  if (gen !== liveLoop.generation) {
    return;
  }
  setTimeout(() => {
    void liveTick(base, token, gen);
  }, delay);
}

function startLive(base: string, token: string): void {
  liveLoop.generation++;
  liveLoop.running = true;
  liveLoop.sessionId = undefined;
  liveStatusToUi("connecting");
  void liveTick(base, token, liveLoop.generation);
}

function stopLive(): void {
  liveLoop.generation++; // orphans any in-flight poll
  liveLoop.running = false;
  liveStatusToUi("off");
}

async function pingHealth(
  base: string,
): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const res = await fetch(`${base}/health`);
    if (res.ok) {
      return { ok: true, status: res.status, message: "Bridge OK" };
    }
    return { ok: false, status: res.status, message: `Bridge lỗi (${res.status})` };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Không kết nối được bridge — đã chạy `pnpm bridge` chưa?",
    };
  }
}

async function saveSettings(msg: ExportMsg): Promise<void> {
  await figma.clientStorage.setAsync("bridgeUrl", msg.bridgeUrl);
  await figma.clientStorage.setAsync("bridgeToken", msg.token ?? "");
  await figma.clientStorage.setAsync("phase", msg.phase);
  await figma.clientStorage.setAsync("scope", msg.scope);
  await figma.clientStorage.setAsync("includeRaster", msg.includeRaster);
}

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === "live") {
    await figma.clientStorage.setAsync("liveEnabled", msg.enabled);
    if (msg.enabled) {
      startLive(msg.bridgeUrl.replace(/\/$/, ""), msg.token ?? "");
    } else {
      stopLive();
    }
    return;
  }
  if (msg.type === "ping") {
    const base = msg.bridgeUrl.replace(/\/$/, "");
    const h = await pingHealth(base);
    figma.ui.postMessage({ type: "health", ok: h.ok, message: h.message });
    return;
  }
  if (msg.type !== "export") {
    return;
  }

  await saveSettings(msg);
  const base = msg.bridgeUrl.replace(/\/$/, "");

  // Fail fast: check the bridge BEFORE serializing the whole scene.
  const health = await pingHealth(base);
  figma.ui.postMessage({ type: "health", ok: health.ok, message: health.message });
  if (!health.ok) {
    figma.ui.postMessage({
      type: "done",
      ok: false,
      status: health.status,
      body: { error: health.message },
    });
    figma.notify(health.message, { error: true });
    return;
  }

  try {
    const payload = await buildExportPayload({
      phase: msg.phase,
      scope: msg.scope,
      includeRaster: Boolean(msg.includeRaster),
    });
    const res = await fetch(`${base}/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Token": msg.token ?? "",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { raw: text };
    }

    const meta = (payload.meta ?? {}) as Record<string, unknown>;
    const reply = (parsed ?? {}) as Record<string, unknown>;
    const saved = typeof reply.saved === "string" ? reply.saved : "";
    const omitted =
      typeof meta.omittedCount === "number" ? meta.omittedCount : 0;
    const nodes = typeof meta.nodeCount === "number" ? meta.nodeCount : 0;
    const maxNodes = typeof meta.maxNodes === "number" ? meta.maxNodes : 0;
    const rr = (meta.rasterReport ?? {}) as {
      previews?: unknown[];
      imageCount?: number;
      skipped?: unknown[];
    };
    const summary = res.ok
      ? {
          basename: saved.split("/").pop() ?? "",
          nodes,
          omitted,
          maxNodes,
          phase: msg.phase,
          scope: msg.scope,
          bytes: typeof reply.bytes === "number" ? reply.bytes : 0,
          truncated: omitted > 0 || (maxNodes > 0 && nodes >= maxNodes),
          previews: Array.isArray(rr.previews) ? rr.previews.length : 0,
          images: typeof rr.imageCount === "number" ? rr.imageCount : 0,
          rasterSkipped: Array.isArray(rr.skipped) ? rr.skipped.length : 0,
        }
      : undefined;

    figma.ui.postMessage({
      type: "done",
      ok: res.ok,
      status: res.status,
      summary,
      body: parsed,
    });
    if (res.ok) {
      figma.notify(`Đã export ${nodes} node lên bridge.`);
    } else if (res.status === 401) {
      figma.notify("Bridge từ chối: token sai/thiếu — kiểm tra ô Bridge token.", {
        error: true,
      });
    } else {
      figma.notify("Bridge trả lỗi — xem log trong plugin.", { error: true });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    figma.ui.postMessage({
      type: "done",
      ok: false,
      status: 0,
      body: { error: message },
    });
    figma.notify(message, { error: true });
  }
};

const html = `
<style>
  * { box-sizing: border-box; font-family: system-ui, sans-serif; font-size: 12px; }
  body { margin: 0; padding: 12px; color: #111; }
  label { display: block; margin-bottom: 6px; font-weight: 600; }
  select, input { width: 100%; padding: 6px 8px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px; }
  button { width: 100%; padding: 8px; border: none; border-radius: 4px; background: #18a0fb; color: #fff; font-weight: 600; cursor: pointer; }
  button.secondary { background: #eee; color: #333; padding: 6px; font-weight: 500; }
  button:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .hint { color: #666; font-size: 11px; margin-top: -6px; margin-bottom: 8px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 999px; margin-bottom: 10px; background: #eee; color: #555; }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #bbb; }
  .pill.ok { background: #e6f7ec; color: #1a7f37; } .pill.ok .dot { background: #1a7f37; }
  .pill.bad { background: #fde8e8; color: #b42318; } .pill.bad .dot { background: #b42318; }
  .log { margin-top: 10px; white-space: pre-wrap; word-break: break-word; color: #333; max-height: 120px; overflow: auto; border: 1px solid #eee; padding: 8px; border-radius: 4px; font-size: 11px; }
  .log .ok { color: #1a7f37; font-weight: 600; }
  .log .warn { color: #9a6700; background: #fff8e1; display: block; padding: 4px 6px; border-radius: 4px; margin-top: 6px; }
  .log .err { color: #b42318; font-weight: 600; }
  .log code { background: #f3f3f3; padding: 1px 4px; border-radius: 3px; }
</style>
<span id="pill" class="pill"><span class="dot"></span><span id="pillText">Chưa kiểm tra</span></span>
<label>Bridge URL</label>
<input id="url" value="http://localhost:3846" />
<label>Bridge token</label>
<input id="token" placeholder="dán token in ở terminal" />
<div class="hint">Lấy từ dòng "[figma-bridge] token: …" khi chạy pnpm bridge (lưu lại tự động)</div>
<button id="ping" class="secondary">Kiểm tra kết nối</button>
<div style="height:10px"></div>
<label>Phase</label>
<select id="phase">
  <option value="1">1 — Cây layout &amp; hình học</option>
  <option value="2" selected>2 — + Variables, text/effect chi tiết</option>
  <option value="3">3 — + Component/variant + PNG (chọn raster)</option>
</select>
<label>Scope</label>
<select id="scope">
  <option value="selection" selected>Selection</option>
  <option value="page">Toàn bộ page</option>
</select>
<div class="row">
  <input type="checkbox" id="raster" style="width:auto;margin:0" />
  <label for="raster" style="margin:0;font-weight:500">PNG preview (phase 3, tối đa 8 màn + 12 ảnh nhúng)</label>
</div>
<button id="run">Export → bridge</button>
<div class="row" style="margin-top:12px;border-top:1px solid rgba(128,128,128,.25);padding-top:10px">
  <input type="checkbox" id="live" style="width:auto;margin:0" />
  <label for="live" style="margin:0;font-weight:500">Chế độ live — cho AI tự lấy dữ liệu</label>
</div>
<div class="log" id="liveLog">Tắt. Bật để Cursor/Claude gọi figma_bridge_live_capture mà bạn không phải bấm export. Panel phải mở.</div>
<div class="log" id="log"></div>
<script>
  const $ = (id) => document.getElementById(id);
  const run = $("run"), log = $("log"), pill = $("pill"), pillText = $("pillText");

  function setPill(state, text) {
    pill.className = "pill" + (state ? " " + state : "");
    pillText.textContent = text;
  }
  function fmtKB(b) { return b ? (b / 1024).toFixed(1) + " KB" : "?"; }

  function doExport() {
    run.disabled = true;
    log.textContent = "…";
    parent.postMessage({ pluginMessage: {
      type: "export",
      phase: parseInt($("phase").value, 10),
      scope: $("scope").value,
      bridgeUrl: $("url").value.trim(),
      token: $("token").value.trim(),
      includeRaster: $("raster").checked,
    } }, "*");
  }
  function doPing() {
    setPill("", "Đang kiểm tra…");
    parent.postMessage({ pluginMessage: {
      type: "ping", bridgeUrl: $("url").value.trim(), token: $("token").value.trim(),
    } }, "*");
  }
  function doLive() {
    parent.postMessage({ pluginMessage: {
      type: "live",
      enabled: $("live").checked,
      bridgeUrl: $("url").value.trim(),
      token: $("token").value.trim(),
    } }, "*");
  }
  run.onclick = doExport;
  $("ping").onclick = doPing;
  $("live").onchange = doLive;

  const LIVE_TEXT = {
    off: 'Tắt. Bật để Cursor/Claude gọi figma_bridge_live_capture mà bạn không phải bấm export. Panel phải mở.',
    connecting: '<span class="warn">Đang kết nối…</span>',
    connected: '<span class="ok">● Live — đang chờ yêu cầu từ AI.</span> Giữ panel mở.',
    working: '<span class="ok">● Đang phục vụ một yêu cầu…</span>',
  };

  window.onmessage = (event) => {
    const m = event.data.pluginMessage;
    if (!m) return;
    if (m.type === "init") {
      if (m.bridgeUrl) $("url").value = m.bridgeUrl;
      $("token").value = m.token || "";
      if (m.phase) $("phase").value = String(m.phase);
      if (m.scope) $("scope").value = m.scope;
      $("raster").checked = !!m.includeRaster;
      doPing();
      return;
    }
    if (m.type === "health") {
      setPill(m.ok ? "ok" : "bad", m.message);
      return;
    }
    if (m.type === "liveStatus") {
      const box = $("liveLog");
      if (m.state === "error" || m.state === "retrying") {
        box.innerHTML = '<span class="err">⚠ ' + (m.detail || m.state) + '</span>';
        if (m.state === "error") $("live").checked = false;
      } else {
        box.innerHTML = LIVE_TEXT[m.state] || m.state;
      }
      return;
    }
    if (m.type === "done") {
      run.disabled = false;
      if (m.ok && m.summary) {
        const s = m.summary;
        let html = '<span class="ok">✓ Đã export</span> · <code>' + s.basename + '</code>'
          + '<br>' + s.nodes + ' node · ' + fmtKB(s.bytes) + ' · phase ' + s.phase + ' · ' + s.scope;
        if (s.previews || s.images) {
          html += '<br>🖼 ' + s.previews + ' ảnh màn hình · ' + s.images + ' ảnh nhúng';
        }
        if (s.truncated) {
          html += '<span class="warn">⚠ Bị cắt bớt: ' + s.omitted + ' node bị bỏ (chạm maxNodes/maxDepth). '
            + 'Thu hẹp selection hoặc tăng giới hạn để đủ dữ liệu.</span>';
        }
        if (s.rasterSkipped) {
          html += '<span class="warn">⚠ ' + s.rasterSkipped + ' ảnh bị bỏ qua — xem meta.rasterReport.skipped '
            + 'trong file JSON để biết lý do.</span>';
        }
        log.innerHTML = html;
      } else {
        const err = (m.body && (m.body.error || JSON.stringify(m.body))) || ("HTTP " + m.status);
        log.innerHTML = '<span class="err">✗ ' + err + '</span>';
      }
      return;
    }
  };
</script>
`;

figma.showUI(html, { width: 340, height: 420, themeColors: true });

// Prefill bridge URL + token + last options from clientStorage, then auto-ping.
void (async () => {
  const get = async (k: string) => figma.clientStorage.getAsync(k);
  const url = (await get("bridgeUrl")) as string | undefined;
  const token = (await get("bridgeToken")) as string | undefined;
  const phase = (await get("phase")) as number | undefined;
  const scope = (await get("scope")) as string | undefined;
  const includeRaster = (await get("includeRaster")) as boolean | undefined;
  figma.ui.postMessage({
    type: "init",
    bridgeUrl: typeof url === "string" && url ? url : "http://localhost:3846",
    token: typeof token === "string" ? token : "",
    phase: typeof phase === "number" ? phase : 2,
    scope: scope === "page" ? "page" : "selection",
    includeRaster: includeRaster === true,
  });
})();
