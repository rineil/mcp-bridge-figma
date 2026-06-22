# mcp-bridge-figma

Luồng: **Figma plugin** `POST` JSON → **HTTP bridge** (ghi file vào `exports/`) → **MCP stdio** (`figma_bridge_*`) đọc file đó.

## Yêu cầu

- Node 20+
- [pnpm](https://pnpm.io/)

## Cài đặt

```bash
cd mcp-bridge-figma
pnpm install
pnpm build:plugin
pnpm build:mcp
```

`build:mcp` tạo `dist-mcp/server.js` — **nên dùng cho Cursor MCP** (chỉ `node`, không nhiễu stdout).

## 1) Chạy bridge (HTTP)

```bash
pnpm bridge
```

Mặc định: `http://localhost:3845` — `GET /health` (mở), `POST /export` (**cần token**).

Khi chạy, bridge in ra dòng:

```
[figma-bridge] token: <chuỗi hex>
```

**Dán token này vào ô "Bridge token" trong plugin** (plugin lưu lại qua `clientStorage`, chỉ phải dán 1 lần). `POST /export` không kèm header `X-Bridge-Token` đúng → `401`. Mục đích: một trang web bất kỳ (hoặc tiến trình local khác) không thể ghi JSON tùy ý vào `exports/` để đầu độc dữ liệu mà agent đọc.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|------|-----------|---------|
| `BRIDGE_PORT` | `3845` | Cổng HTTP |
| `BRIDGE_HOST` | `localhost` | Host bind |
| `FIGMA_EXPORT_DIR` | `./exports` (theo cwd) | Thư mục ghi JSON |
| `BRIDGE_TOKEN` | *(tự sinh)* | Token cố định cho `POST /export`. Nếu không đặt, bridge sinh ngẫu nhiên và lưu ở `<exportDir>/.bridge-token` (ổn định qua các lần restart). |
| `BRIDGE_MAX_BYTES` | `67108864` (64MB) | Giới hạn kích thước body `POST` (chống nuốt bộ nhớ); vượt → `413`. |

> **Cổng 3845 trùng cổng mặc định của Figma Dev Mode MCP Server.** Nếu bạn chạy cả hai, đặt `BRIDGE_PORT` (và sửa `devAllowedDomains` trong manifest cho khớp).

**Localhost / import manifest:** Figma không cho để `http://localhost:…` trong `allowedDomains` mà không có `reasoning`, và khuyên dùng `devAllowedDomains` cho server dev. Manifest dùng `allowedDomains: ["none"]` + `devAllowedDomains` (cổng 3845) để import được và `fetch` tới bridge **khi chạy plugin dạng development** (import từ manifest). Nếu đổi cổng, sửa cả hai URL trong `devAllowedDomains` cho khớp.

## 2) Nạp plugin trong Figma

1. Figma → **Plugins** → **Development** → **Import plugin from manifest…**
2. Chọn `mcp-bridge-figma/plugin/manifest.json` (sau khi đã `pnpm build:plugin` để có `plugin/dist/code.js`).
3. Mở file thiết kế, chạy plugin **Reform MCP Bridge**, **dán Bridge token** (in ở terminal lúc `pnpm bridge`), chọn phase / scope, bấm **Export → bridge** (bridge phải đang chạy).

File JSON xuất hiện trong `mcp-bridge-figma/exports/`.

## 3) MCP trong Cursor

**Khuyến nghị (ổn định nhất):** sau `pnpm build:mcp`, chạy file bundle — **không** qua `pnpm run …` (pnpm hay in lifecycle ra **stdout** → parser MCP lỗi → `Connection closed` / `-32000`).

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "node",
      "args": [
        "path/to/mcp-bridge-figma/dist-mcp/server.js"
      ],
      "cwd": "path/to/reform/mcp-bridge-figma",
      "env": {
        "FIGMA_EXPORT_DIR": "path/to/reform/mcp-bridge-figma/exports"
      }
    }
  }
}
```

Đổi các đường dẫn `path/to...` thành đúng máy bạn. **Dùng đường dẫn tuyệt đối trong `args`** (tới `dist-mcp/server.js`): một số bản Cursor không áp dụng `cwd` khi spawn `node`, nên `dist-mcp/server.js` tương đối bị resolve thành **`$HOME/dist-mcp/server.js`** → lỗi `Cannot find module '/Users/<bạn>/dist-mcp/server.js'`.

**Tuỳ chọn (dev):** `pnpm exec tsx src/mcp/server.ts` — thường sạch stdout hơn `pnpm run mcp`, nhưng vẫn phụ thuộc PATH có `pnpm`.

**Tránh:** `"args": ["mcp"]` hoặc `pnpm run mcp` trong cấu hình MCP.

Sau khi đổi cấu hình: reload MCP / restart Cursor. Nếu vẫn lỗi, trong terminal kiểm tra:

```bash
cd mcp-bridge-figma && pnpm build:mcp && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | node dist-mcp/server.js | head -c 1
```

Ký tự đầu phải là `{` (không được xuống dòng hay `>` trước đó).

Công cụ:

- `figma_bridge_list_exports` — danh sách file `.json` (mới nhất trước).
- `figma_bridge_read_export` — đọc nguyên một file (tham số `name` = basename an toàn, kết thúc `.json`).
- `figma_bridge_export_schema_hint` — mô tả nhanh các phase + gợi ý schema.
- `figma_bridge_export_outline` — **cây mục lục nhẹ** (meta + id/name/type/bbox/childCount, cắt theo `maxDepth`), không kèm fills/effects/text/variables/rasters. Dùng **đầu tiên** để điều hướng file lớn.
- `figma_bridge_read_node` — đọc **một subtree** theo `nodeId` (tùy chọn `depth`); chi phí context tỉ lệ với node, không phải cả file.
- `figma_bridge_search_nodes` — tìm node theo `query` khớp tên/loại → danh sách `{id,name,type,bbox}` để đưa vào `read_node`.
- `figma_bridge_get_raster` — lấy **một** raster base64 theo `key` (node id hoặc image hash) từ `rasters`, để byte ảnh nặng không lọt vào lần đọc node.

> Luồng khuyến nghị cho file lớn: `export_outline` → `search_nodes` → `read_node` (thay vì `read_export` đọc cả file).

## Schema JSON

Xem `schema/export-v3.schema.json` — `roots[]` theo `$defs/node`. Mỗi node (plugin v0.3+) gồm:

- `bbox` có `space: "absolute" | "relative"` (đừng trộn 2 hệ toạ độ); thêm `rel` — hộp **tương đối với parent** (left/top/width/height sẵn cho CSS absolute).
- `layout` — auto-layout của container (gồm `layoutGrids` và `css` — block flexbox sẵn dùng: display/flexDirection/justifyContent/alignItems/gap/padding).
- `layoutSelf` — sizing/độ co giãn theo từng node: `constraints`, `layoutSizingHorizontal/Vertical` (FIXED/HUG/FILL), `layoutGrow`, `layoutAlign`, `min/maxWidth/Height`.
- `fills`/`strokes` — màu có sẵn **`cssColor`** (#hex/rgba, đã gộp opacity); gradient lưu **đầy đủ stops (kèm cssColor) + `gradientTransform`**; stroke có `dashPattern`/`strokeCap`/`strokeJoin`.
- `geometry` — vector path (`fillGeometry`/`strokeGeometry` dạng SVG path) cho VECTOR/BOOLEAN_OPERATION/LINE/POLYGON/STAR → dựng lại icon bằng `<path d>`.
- `text.segments` (phase ≥ 2) — style theo từng đoạn (đậm/màu/cỡ riêng) thay vì gộp thành `"mixed"`; thêm `fontWeight`.
- `isMask`/`maskType`.

Phase ≥ 2: `variables` là **bảng token gọn** (chỉ token được tham chiếu, đã resolve `value` + `cssColor` theo mode mặc định); paint nào bind variable có thêm `tokens` ngay tại paint. Phase 3 vẫn thêm component/variant + raster.

## Lưu ý

- Đây là **dữ liệu cục bộ**: không thay thế Figma REST API hay quota gói Figma; chỉ giảm phụ thuộc vào **MCP cloud** khi làm việc với snapshot đã export.
- File page lớn có thể rất nặng; plugin giới hạn `maxNodes` / `maxDepth` và có thể đánh dấu `omitted`.
- PNG base64 chỉ bật khi **phase 3** + checkbox raster; khuyến nghị chỉ dùng trên vài frame nhỏ.
