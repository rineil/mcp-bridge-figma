/// <reference types="@figma/plugin-typings" />

import {
  buildExportPayload,
  type ExportPhase,
  type ExportScope,
} from "./serialize";

type UiMessage = {
  type: "export";
  phase: ExportPhase;
  scope: ExportScope;
  bridgeUrl: string;
  token: string;
  includeRaster: boolean;
};

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type !== "export") {
    return;
  }
  const base = msg.bridgeUrl.replace(/\/$/, "");
  // Remember the bridge URL + token so the user only pastes the token once.
  await figma.clientStorage.setAsync("bridgeUrl", msg.bridgeUrl);
  await figma.clientStorage.setAsync("bridgeToken", msg.token ?? "");
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
    figma.ui.postMessage({
      type: "done",
      ok: res.ok,
      status: res.status,
      body: parsed,
    });
    if (res.ok) {
      figma.notify("Đã gửi export lên bridge.");
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
  button:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .log { margin-top: 10px; white-space: pre-wrap; word-break: break-all; color: #333; max-height: 72px; overflow: auto; border: 1px solid #eee; padding: 6px; border-radius: 4px; font-size: 11px; }
  .hint { color: #666; font-size: 11px; margin-top: -6px; margin-bottom: 8px; }
</style>
<label>Bridge URL</label>
<input id="url" value="http://localhost:3845" />
<div class="hint">Chạy: pnpm bridge trong thư mục mcp-bridge-figma</div>
<label>Bridge token</label>
<input id="token" placeholder="dán token in ở terminal" />
<div class="hint">Lấy từ dòng "[figma-bridge] token: …" khi chạy pnpm bridge (lưu lại tự động)</div>
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
  <input type="checkbox" id="raster" />
  <label for="raster" style="margin:0;font-weight:500">PNG preview (phase 3, tối đa 5 layer gốc)</label>
</div>
<button id="run">Export → bridge</button>
<div class="log" id="log"></div>
<script>
  const run = document.getElementById("run");
  const log = document.getElementById("log");
  function post() {
    run.disabled = true;
    log.textContent = "…";
    parent.postMessage({
      pluginMessage: {
        type: "export",
        phase: parseInt(document.getElementById("phase").value, 10),
        scope: document.getElementById("scope").value,
        bridgeUrl: document.getElementById("url").value.trim(),
        token: document.getElementById("token").value.trim(),
        includeRaster: document.getElementById("raster").checked,
      }
    }, "*");
  }
  run.onclick = post;
  window.onmessage = (event) => {
    const m = event.data.pluginMessage;
    if (!m) return;
    if (m.type === "init") {
      if (m.bridgeUrl) document.getElementById("url").value = m.bridgeUrl;
      document.getElementById("token").value = m.token || "";
      return;
    }
    if (m.type !== "done") return;
    run.disabled = false;
    log.textContent = JSON.stringify(m.body, null, 2);
  };
</script>
`;

figma.showUI(html, { width: 340, height: 320, themeColors: true });

// Prefill the bridge URL + token from the last run (stored via clientStorage).
void (async () => {
  const url = (await figma.clientStorage.getAsync("bridgeUrl")) as
    | string
    | undefined;
  const token = (await figma.clientStorage.getAsync("bridgeToken")) as
    | string
    | undefined;
  figma.ui.postMessage({
    type: "init",
    bridgeUrl: typeof url === "string" && url ? url : "http://localhost:3845",
    token: typeof token === "string" ? token : "",
  });
})();
