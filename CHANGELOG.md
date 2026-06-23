# Changelog

Tất cả thay đổi đáng chú ý của dự án này được ghi ở đây.

Định dạng theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), và dự án
tuân theo [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Chưa có thay đổi chưa phát hành._

## [0.7.0] - 2026-06-23

Hoàn tất phần "nặng" của dedup component + codegen. Phiên bản: plugin `0.7.0`, MCP server `0.9.0`.

### Added

- **Registry định nghĩa component + override per-instance**: phase 3 serialize mỗi
  main component **local** một lần vào `components` (resolve qua `getNodeByIdAsync`,
  counter riêng, cap 40); INSTANCE thêm `component.overrides` (`inst.overrides`).
  Tool **`figma_bridge_read_component`** đọc định nghĩa; `list_components` đánh dấu
  `hasDefinition` ([#22](https://github.com/rineil/mcp-bridge-figma/pull/22)).
- **`figma_bridge_codegen` thêm `framework: "react-tailwind"`** (className utilities
  + arbitrary props) bên cạnh `react-inline`
  ([#23](https://github.com/rineil/mcp-bridge-figma/pull/23)).

## [0.6.0] - 2026-06-23

Nhóm tính năng nâng cao cho việc dựng UI. Phiên bản: plugin `0.6.0`, MCP server `0.7.0`.

### Added

- **Multi-mode token**: biến có collection >1 mode (vd light/dark) thêm mảng
  `byMode` `[{mode,value,cssColor}]` resolve mọi mode (alias theo từng mode) →
  sinh `:root`/`.dark` ([#16](https://github.com/rineil/mcp-bridge-figma/pull/16)).
- **`figma_bridge_codegen`** — sinh khung **JSX (React inline-style)** cho 1 node,
  gộp `css`/`layout.css` (text→`<span>`, vector→`<svg>`, ảnh→`<img data-raster>`)
  ([#17](https://github.com/rineil/mcp-bridge-figma/pull/17)).
- **`figma_bridge_list_components`** — gom INSTANCE (phase 3) theo main component
  → inventory `[{id,name,count,instanceIds}]` để nhận diện component lặp và dựng
  library ([#19](https://github.com/rineil/mcp-bridge-figma/pull/19)).

### Changed

- **Server MCP tự nhúng bridge** (1 launchable; tắt bằng `BRIDGE_EMBED=0`) —
  không cần chạy `pnpm bridge` riêng. Logic tách ra `src/shared/bridgeCore.ts`;
  bridge nhúng log ra **stderr** (stdout là JSON-RPC); xử lý `EADDRINUSE`
  ([#18](https://github.com/rineil/mcp-bridge-figma/pull/18)).

## [0.5.0] - 2026-06-23

Tập trung vào chất lượng "design → code" và hạ tầng dev. Phiên bản: plugin
`0.5.1`, MCP server `0.4.0`.

### Added

- **Block `css` cho từng node** (sẵn dùng): `background` (cssColor/cssGradient),
  `border`, `borderRadius`, `boxShadow`, `filter`/`backdropFilter`, `opacity`, và
  `position/left/top/width/height` từ `rel` khi node không phải con auto-layout
  ([#10](https://github.com/rineil/mcp-bridge-figma/pull/10)).
- **`cssGradient`** — chuỗi gradient CSS suy từ `gradientTransform` (góc linear đã
  kiểm chứng: identity→`90deg`, swap→`180deg`; radial/angular/diamond là xấp xỉ);
  **`cssBoxShadow`**/`cssBlurFilters`; chuyển đổi text CSS `cssLineHeight`/
  `cssLetterSpacing`/`cssTextTransform`/`cssTextDecoration`
  ([#10](https://github.com/rineil/mcp-bridge-figma/pull/10)).
- **MCP `figma_bridge_get_raster`** trả về **image content block** (kèm MIME suy ra)
  để agent multimodal nhìn được node
  ([#12](https://github.com/rineil/mcp-bridge-figma/pull/12)).
- **`name: "latest"`** cho mọi tool đọc; bridge ghi con trỏ `exports/_latest.txt`;
  đặt tên file export theo **document + frame** (vd `MyFile_LoginScreen_<stamp>.json`)
  ([#12](https://github.com/rineil/mcp-bridge-figma/pull/12)).
- **`pnpm print-mcp-config`** — in JSON cấu hình MCP sẵn dán (đường dẫn tuyệt đối)
  ([#12](https://github.com/rineil/mcp-bridge-figma/pull/12)).
- **UX plugin**: kiểm tra `/health` trước khi export (fail-fast) + đèn trạng thái;
  tóm tắt export dễ đọc + cảnh báo cắt cụt (`meta.omittedCount`); nhớ phase/scope/
  raster qua `clientStorage`
  ([#11](https://github.com/rineil/mcp-bridge-figma/pull/11)).
- **Test + CI**: bộ vitest (45 test) + fixtures; GitHub Actions
  (typecheck `src` + plugin → test → build 2 bundle → smoke "stdout MCP sạch");
  `tsconfig.plugin.json` + `pnpm typecheck:plugin`
  ([#9](https://github.com/rineil/mcp-bridge-figma/pull/9)).

### Changed

- Tách helper figma-free vào `plugin/pure.ts` và `src/shared/*` để test được
  (không đổi output) ([#9](https://github.com/rineil/mcp-bridge-figma/pull/9)).
- Thêm `meta.omittedCount` vào export meta
  ([#11](https://github.com/rineil/mcp-bridge-figma/pull/11)).

### Fixed

- Dọn 3 cảnh báo `figma.mixed` (TS2367) bằng helper `isMixed()` → plugin typecheck
  sạch ([#9](https://github.com/rineil/mcp-bridge-figma/pull/9)).

## [0.4.0] - 2026-06-22

Bản phát hành đầu: pipeline plugin → bridge → MCP hoàn chỉnh cho việc export thiết
kế Figma ra JSON cục bộ.

### Added

- **Độ trung thực serializer**: per-child auto-layout sizing + constraints,
  gradient stops đầy đủ, vector geometry (SVG paths), text segments, mask, stroke
  dash/cap/join, `bbox.space`
  ([#2](https://github.com/rineil/mcp-bridge-figma/pull/2)).
- **Output thân thiện AI**: `cssColor`, bảng token gọn đã resolve + `tokens` tại
  paint, `rel` (toạ độ tương đối parent), `layout.css` (flexbox)
  ([#3](https://github.com/rineil/mcp-bridge-figma/pull/3)).
- **MCP tools điều hướng**: `figma_bridge_export_outline`/`read_node`/
  `search_nodes`/`get_raster`; resolve image bytes vào `rasters`
  ([#4](https://github.com/rineil/mcp-bridge-figma/pull/4)).
- README onboarding ([#7](https://github.com/rineil/mcp-bridge-figma/pull/7)).

### Fixed

- Dùng API Figma **async** dưới `documentAccess: "dynamic-page"` — trước đó sync
  getter bị throw khiến Phase 2 `variables` rỗng ngầm và Phase 3 (INSTANCE) fail
  ([#1](https://github.com/rineil/mcp-bridge-figma/pull/1)).

### Security

- **Bridge**: token gate (`X-Bridge-Token`), giới hạn body (`413`), timestamp
  server-side + `writeFile` cờ `wx` (không ghi đè), `/health` không lộ `exportDir`
  ([#5](https://github.com/rineil/mcp-bridge-figma/pull/5)).

[Unreleased]: https://github.com/rineil/mcp-bridge-figma/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/rineil/mcp-bridge-figma/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rineil/mcp-bridge-figma/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rineil/mcp-bridge-figma/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rineil/mcp-bridge-figma/releases/tag/v0.4.0
