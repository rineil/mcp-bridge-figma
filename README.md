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

Mặc định: `http://localhost:3845` — `GET /health`, `POST /export`.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|------|-----------|---------|
| `BRIDGE_PORT` | `3845` | Cổng HTTP |
| `BRIDGE_HOST` | `localhost` | Host bind |
| `FIGMA_EXPORT_DIR` | `./exports` (theo cwd) | Thư mục ghi JSON |

**Localhost / import manifest:** Figma không cho để `http://localhost:…` trong `allowedDomains` mà không có `reasoning`, và khuyên dùng `devAllowedDomains` cho server dev. Manifest dùng `allowedDomains: ["none"]` + `devAllowedDomains` (cổng 3845) để import được và `fetch` tới bridge **khi chạy plugin dạng development** (import từ manifest). Nếu đổi cổng, sửa cả hai URL trong `devAllowedDomains` cho khớp.

## 2) Nạp plugin trong Figma

1. Figma → **Plugins** → **Development** → **Import plugin from manifest…**
2. Chọn `mcp-bridge-figma/plugin/manifest.json` (sau khi đã `pnpm build:plugin` để có `plugin/dist/code.js`).
3. Mở file thiết kế, chạy plugin **Reform MCP Bridge**, chọn phase / scope, bấm **Export → bridge** (bridge phải đang chạy).

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
- `figma_bridge_read_export` — đọc một file (tham số `name` = basename an toàn, kết thúc `.json`).
- `figma_bridge_export_schema_hint` — mô tả nhanh các phase + gợi ý schema.

## Schema JSON

Xem `schema/export-v3.schema.json` — `roots[]` theo `$defs/node`. Mỗi node (plugin v0.2+) gồm:

- `bbox` có `space: "absolute" | "relative"` (đừng trộn 2 hệ toạ độ).
- `layout` — auto-layout của container (gồm `layoutGrids`).
- `layoutSelf` — sizing/độ co giãn theo từng node: `constraints`, `layoutSizingHorizontal/Vertical` (FIXED/HUG/FILL), `layoutGrow`, `layoutAlign`, `min/maxWidth/Height`.
- `fills`/`strokes` — gradient lưu **đầy đủ stops + `gradientTransform`**; stroke có `dashPattern`/`strokeCap`/`strokeJoin`.
- `geometry` — vector path (`fillGeometry`/`strokeGeometry` dạng SVG path) cho VECTOR/BOOLEAN_OPERATION/LINE/POLYGON/STAR → dựng lại icon bằng `<path d>`.
- `text.segments` (phase ≥ 2) — style theo từng đoạn (đậm/màu/cỡ riêng) thay vì gộp thành `"mixed"`; thêm `fontWeight`.
- `isMask`/`maskType`.

Phase 2/3 vẫn thêm field tùy chọn (variables, component/variant, raster).

## Lưu ý

- Đây là **dữ liệu cục bộ**: không thay thế Figma REST API hay quota gói Figma; chỉ giảm phụ thuộc vào **MCP cloud** khi làm việc với snapshot đã export.
- File page lớn có thể rất nặng; plugin giới hạn `maxNodes` / `maxDepth` và có thể đánh dấu `omitted`.
- PNG base64 chỉ bật khi **phase 3** + checkbox raster; khuyến nghị chỉ dùng trên vài frame nhỏ.
