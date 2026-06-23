# mcp-bridge-figma

Export thiết kế Figma ra **JSON cục bộ** để Claude / Cursor dựng lại UI/Frontend **đúng theo thông số thiết kế** — không cần trả phí cho Figma Dev Mode MCP.

```
┌──────────────┐   POST /export    ┌──────────────┐   đọc file   ┌──────────────┐
│ Figma plugin │ ────────────────► │  HTTP bridge │ ───────────► │  MCP (stdio) │ ──► Claude / Cursor
│  (serialize) │   + X-Bridge-Token│ ghi exports/ │   *.json     │ figma_bridge_*│
└──────────────┘                   └──────────────┘              └──────────────┘
```

## Đây là gì & vì sao có nó

Bạn muốn AI (Claude Code / Cursor) sinh code Frontend bám sát file Figma, nhưng:

- **Figma REST API**: miễn phí về mặt token, **nhưng** gói Starter bị giới hạn **~6 request/tháng/file** → không dùng lặp được cho design-to-code.
- **Figma Dev Mode MCP Server**: cần **ghế Dev/Full trả phí**.

Plugin (chạy ngay trong Figma) là con đường **miễn phí** duy nhất khả thi: không bị rate limit, đọc được **cả file nháp/local**, lấy được **giá trị đã resolve** + xuất raster tại chỗ. Tool này serialize scene graph thành JSON, đẩy qua một bridge HTTP cục bộ, rồi expose cho AI qua MCP.

> Đây là **dữ liệu cục bộ** (snapshot đã export), không thay thế Figma REST API hay quota gói Figma.

## Yêu cầu

- Node 22+ (bộ công cụ dùng pnpm 11.8, yêu cầu Node ≥ 22.13; bản MCP/bridge build ra vẫn chạy Node 20+)
- [pnpm](https://pnpm.io/)
- Figma (desktop hoặc web) để import plugin dạng development

## Bắt đầu nhanh (TL;DR)

```bash
# 1. Cài + build
cd mcp-bridge-figma
pnpm install
pnpm build:plugin   # -> plugin/dist/code.js
pnpm build:mcp      # -> dist-mcp/server.js

# 2. Chạy bridge (để chạy nền, mở terminal riêng)
pnpm bridge         # in ra: [figma-bridge] token: <hex>  → copy token này
```

3. **Figma → Plugins → Development → Import plugin from manifest…** → chọn `plugin/manifest.json`.
4. Chạy plugin **Reform MCP Bridge**, **dán Bridge token** vừa copy, chọn phase/scope, bấm **Export → bridge**. File JSON xuất hiện trong `exports/`.
5. Cấu hình MCP trong Cursor/Claude (xem [mục 3](#3-mcp-trong-cursor--claude)) trỏ tới `dist-mcp/server.js`.
6. Bảo AI: *“dùng `figma_bridge_export_outline` rồi `read_node` để dựng lại màn hình mới nhất”*.

---

## 1) Chạy bridge (HTTP)

```bash
pnpm bridge
```

Mặc định: `http://localhost:3845` — `GET /health` (mở), `POST /export` (**cần token**).

Khi chạy, bridge in ra:

```
[figma-bridge] token: <chuỗi hex>
```

**Dán token này vào ô "Bridge token" trong plugin** (plugin lưu lại qua `clientStorage`, chỉ phải dán 1 lần). `POST /export` không kèm header `X-Bridge-Token` đúng → `401`. Mục đích bảo mật: một trang web bất kỳ bạn mở (hoặc tiến trình local khác) **không thể** ghi JSON tùy ý vào `exports/` để đầu độc dữ liệu mà agent đọc.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|------|-----------|---------|
| `BRIDGE_PORT` | `3845` | Cổng HTTP |
| `BRIDGE_HOST` | `localhost` | Host bind |
| `FIGMA_EXPORT_DIR` | `./exports` (theo cwd) | Thư mục ghi JSON |
| `BRIDGE_TOKEN` | *(tự sinh)* | Token cố định cho `POST /export`. Nếu không đặt, bridge sinh ngẫu nhiên và lưu ở `<exportDir>/.bridge-token` (ổn định qua các lần restart). |
| `BRIDGE_MAX_BYTES` | `67108864` (64MB) | Giới hạn kích thước body `POST` (chống nuốt bộ nhớ); vượt → `413`. |

> **Cổng 3845 trùng cổng mặc định của Figma Dev Mode MCP Server.** Nếu bạn chạy cả hai, đặt `BRIDGE_PORT` (và sửa `devAllowedDomains` trong manifest cho khớp).

**Localhost / import manifest:** Figma không cho để `http://localhost:…` trong `allowedDomains` mà không có `reasoning`, và khuyên dùng `devAllowedDomains` cho server dev. Manifest dùng `allowedDomains: ["none"]` + `devAllowedDomains` (cổng 3845) để import được và `fetch` tới bridge **khi chạy plugin dạng development**. Nếu đổi cổng, sửa cả hai URL trong `devAllowedDomains` cho khớp.

## 2) Nạp plugin trong Figma

1. Figma → **Plugins** → **Development** → **Import plugin from manifest…**
2. Chọn `mcp-bridge-figma/plugin/manifest.json` (sau khi đã `pnpm build:plugin` để có `plugin/dist/code.js`).
3. Mở file thiết kế, chạy plugin **Reform MCP Bridge**, **dán Bridge token** (in ở terminal lúc `pnpm bridge`), chọn phase / scope, bấm **Export → bridge** (bridge phải đang chạy).

File JSON xuất hiện trong `mcp-bridge-figma/exports/`.

Tiện ích trong plugin: **đèn trạng thái + nút "Kiểm tra kết nối"** (ping `/health`, và tự kiểm tra trước mỗi export để **fail-fast** nếu bridge chưa chạy/token sai); sau khi export hiện **tóm tắt** (tên file, số node, KB, phase/scope) và **cảnh báo nếu bị cắt cụt** (`meta.omittedCount > 0` do chạm `maxNodes`/`maxDepth`). URL/token/phase/scope/raster được **nhớ lại** giữa các lần mở.

### Phase nào lấy gì?

| Phase | Nội dung | Khi nào dùng |
|-------|----------|--------------|
| **1** | Cây node + hình học: bbox/rel, fills/strokes (kèm `cssColor`), auto-layout (+ `layout.css` flexbox) & sizing per-node, vector path (icon→SVG), mask, bo góc, nét đứt | Dựng layout nhanh, file nhẹ |
| **2** | + Bảng **design tokens** đã resolve (`variables` gọn + `tokens` tại paint), text per-segment + `fontWeight`, chi tiết effect | Dựng đúng màu/spacing theo token (khuyên dùng) |
| **3** | + Metadata component/variant/instance, + tuỳ chọn **raster PNG** + byte ảnh (`getImageByHash`) | Cần component & ảnh thật |

`Scope`: **Selection** (các layer đang chọn) hoặc **Toàn bộ page**.

## 3) MCP trong Cursor / Claude

**Cách nhanh:** chạy `pnpm print-mcp-config` để in ra khối JSON **sẵn dán** (đường dẫn tuyệt đối đã resolve, tránh lỗi `Cannot find module`). Đặt `FIGMA_EXPORT_DIR` nếu muốn đổi thư mục exports.

**Khuyến nghị (ổn định nhất):** sau `pnpm build:mcp`, chạy file bundle — **không** qua `pnpm run …` (pnpm hay in lifecycle ra **stdout** → parser MCP lỗi → `Connection closed` / `-32000`).

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "node",
      "args": [
        "path/to/mcp-bridge-figma/dist-mcp/server.js"
      ],
      "cwd": "path/to/mcp-bridge-figma",
      "env": {
        "FIGMA_EXPORT_DIR": "path/to/mcp-bridge-figma/exports"
      }
    }
  }
}
```

Đổi các đường dẫn `path/to...` thành đúng máy bạn. **Dùng đường dẫn tuyệt đối trong `args`** (tới `dist-mcp/server.js`): một số bản Cursor không áp dụng `cwd` khi spawn `node`, nên đường dẫn tương đối bị resolve thành **`$HOME/dist-mcp/server.js`** → lỗi `Cannot find module …`.

**Tuỳ chọn (dev):** `pnpm exec tsx src/mcp/server.ts` — thường sạch stdout hơn `pnpm run mcp`, nhưng vẫn phụ thuộc PATH có `pnpm`. **Tránh** `"args": ["mcp"]` hoặc `pnpm run mcp` trong cấu hình MCP.

Sau khi đổi cấu hình: reload MCP / restart Cursor. Nếu vẫn lỗi, kiểm tra stdout sạch:

```bash
cd mcp-bridge-figma && pnpm build:mcp && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | node dist-mcp/server.js | head -c 1
```

Ký tự đầu phải là `{` (không được xuống dòng hay `>` trước đó).

### Công cụ MCP

| Tool | Công dụng |
|------|-----------|
| `figma_bridge_list_exports` | Danh sách file `.json` (mới nhất trước) |
| `figma_bridge_export_outline` | **Cây mục lục nhẹ** (meta + id/name/type/bbox/childCount, cắt theo `maxDepth`) — dùng **đầu tiên** để điều hướng file lớn |
| `figma_bridge_search_nodes` | Tìm node theo tên/loại → `{id,name,type,bbox}` |
| `figma_bridge_read_node` | Đọc **một subtree** theo `nodeId` (tùy chọn `depth`) — chi phí context tỉ lệ với node, không phải cả file |
| `figma_bridge_get_raster` | Lấy **một** raster theo `key` (node id/image hash) — trả về **image block** (agent multimodal nhìn được) + MIME |
| `figma_bridge_read_export` | Đọc **nguyên** một file (fallback cho file nhỏ) |
| `figma_bridge_export_schema_hint` | Mô tả nhanh các phase + gợi ý schema |

> Mọi tool đọc đều nhận **`name: "latest"`** để trỏ tới export mới nhất (bridge ghi con trỏ `_latest.txt` mỗi lần export). File được đặt tên kèm **tên frame** (vd `MyFile_LoginScreen_<stamp>.json`) để dễ nhận biết.

## Dùng JSON với Claude / Cursor

Gợi ý prompt cho AGENT để dựng UI hiệu quả mà không nổ context:

1. `figma_bridge_export_outline` với `name: "latest"` → nắm cấu trúc màn hình vừa export (khỏi đoán tên file).
2. `figma_bridge_search_nodes` / `figma_bridge_read_node` → đọc từng frame cần dựng.
3. Khi sinh code:
   - Áp thẳng **`css`** của node (background/border/radius/shadow/opacity/vị trí đã tính sẵn) — đỡ phải tự ráp từng thuộc tính; `cssColor`/`cssGradient` là giá trị đã resolve.
   - Frame auto-layout: dùng **`layout.css`** (flexbox) + **`layoutSelf`** cho FILL/HUG/FIXED/grow của từng con (thay cho `position:absolute`).
   - **`text.segments`** (+ `cssLineHeight`/`cssLetterSpacing`/…) cho rich text; **`geometry.fillGeometry`** render icon bằng `<path d>`.
   - Màu/spacing là token? Đọc `tokens` ngay tại paint hoặc bảng `variables` (đã resolve) để đặt tên biến/Tailwind theme thay vì hard-code.

> Luồng khuyến nghị cho file lớn: `export_outline` → `search_nodes` → `read_node` (thay vì `read_export` đọc cả file).

## Schema JSON

Xem `schema/export-v3.schema.json` — `roots[]` theo `$defs/node`. Mỗi node (plugin v0.5+) gồm:

- **`css`** — block CSS **sẵn dùng cho chính node**: `background` (cssColor/cssGradient), `border`, `borderRadius`, `boxShadow`, `filter`/`backdropFilter`, `opacity`, và (khi node **không** là con auto-layout) `position/left/top/width/height` từ `rel`.
- `bbox` có `space: "absolute" | "relative"` (đừng trộn 2 hệ toạ độ); `rel` — hộp **tương đối với parent**.
- `layout` — auto-layout container (gồm `layoutGrids` + `css` flexbox); `layoutSelf` — `constraints`, `layoutSizingHorizontal/Vertical` (FIXED/HUG/FILL), `layoutGrow`, `layoutAlign`, `min/maxWidth/Height`.
- `fills`/`strokes` — màu có sẵn **`cssColor`**; gradient có **stops + `gradientTransform` + `cssGradient`** (chuỗi linear/radial/conic; radial/angular/diamond là xấp xỉ); stroke có `dashPattern`/`strokeCap`/`strokeJoin`.
- `geometry` — vector path (`fillGeometry`/`strokeGeometry` SVG) → dựng icon bằng `<path d>`.
- `text.segments` (phase ≥ 2) — style từng đoạn + `fontWeight` + `cssLineHeight`/`cssLetterSpacing`/`cssTextTransform`/`cssTextDecoration`.
- `isMask`/`maskType`.

Phase ≥ 2: `variables` là **bảng token gọn** (chỉ token được tham chiếu, đã resolve `value` + `cssColor` theo mode mặc định); paint nào bind variable có thêm `tokens` ngay tại paint. Phase 3 thêm component/variant + raster (`rasters` map: node id hoặc image hash → base64; lấy qua `figma_bridge_get_raster`).

## Cấu trúc dự án

```
plugin/
  manifest.json     # khai báo plugin (documentAccess: dynamic-page, devAllowedDomains)
  main.ts           # UI plugin + gửi POST (kèm X-Bridge-Token) lên bridge
  serialize.ts      # serialize scene graph Figma -> JSON (trái tim của tool)
  pure.ts           # helper thuần, figma-free (cssColor, resolveTokens…) — test được
src/
  bridge/server.ts  # HTTP bridge: nhận POST, ghi exports/ (token-gated)
  mcp/server.ts      # MCP stdio: list/outline/read_node/search/get_raster/...
  shared/            # tiện ích thuần dùng chung (exportPaths, safeExportName, exportNaming, exportNodes, raster)
scripts/
  print-mcp-config.mjs  # in JSON cấu hình MCP sẵn dán
schema/
  export-v3.schema.json
test/               # vitest: pure/css/exportNodes/exportNaming/safeExportName/raster + fixture
exports/            # nơi JSON xuất ra (gitignored, trừ .gitkeep)
```

## Phát triển

| Lệnh | Việc |
|------|------|
| `pnpm build:plugin` | Bundle plugin → `plugin/dist/code.js` |
| `pnpm build:mcp` | Bundle MCP → `dist-mcp/server.js` |
| `pnpm bridge` | Chạy HTTP bridge (tsx) |
| `pnpm mcp` | Chạy MCP qua tsx (dev) |
| `pnpm print-mcp-config` | In JSON cấu hình MCP sẵn dán (đường dẫn tuyệt đối) |
| `pnpm typecheck` | `tsc --noEmit` cho `src/**` |
| `pnpm typecheck:plugin` | Type-check `plugin/**` (tsconfig.plugin.json + figma typings) |
| `pnpm test` | Unit test (vitest) cho các helper thuần |

- Helper thuần (figma-free) nằm ở `plugin/pure.ts` + `src/shared/*` để **test được** mà không cần runtime Figma; xem `test/`.
- `src/**` check bằng `tsconfig.json`; `plugin/**` check riêng bằng `tsconfig.plugin.json` (esbuild chỉ transpile, không type-check).
- **CI** (`.github/workflows/ci.yml`): install (frozen lockfile) → typecheck src + plugin → test → build 2 bundle → smoke "stdout MCP byte đầu là `{`".

**Quy trình nhánh:** tạo feature branch từ `develop` → PR base `develop` → merge. Phát hành: PR `develop` → `main`.

## Lưu ý / giới hạn

- File page lớn có thể rất nặng; plugin giới hạn `maxNodes` / `maxDepth` và có thể đánh dấu `omitted`.
- PNG/raster + byte ảnh chỉ bật khi **phase 3** + checkbox raster (cap: ≤5 layer gốc PNG, ≤12 ảnh, ≤512KB/ảnh); khuyến nghị dùng có chọn lọc.
- `imageHash` trên IMAGE fill là **không phải URL**; muốn byte ảnh thật thì bật raster (phase 3) rồi lấy qua `figma_bridge_get_raster`.
