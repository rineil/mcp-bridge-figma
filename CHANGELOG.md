# Changelog

Tất cả thay đổi đáng chú ý của dự án này được ghi ở đây.

Định dạng theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), và dự án
tuân theo [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — kênh live

- **`figma_bridge_live_capture` / `figma_bridge_live_status`**: AI tự lấy dữ liệu
  mới từ panel Figma đang mở, khỏi bấm export tay. Kết quả ghi thành file export
  bình thường nên mọi tool đọc sẵn có dùng lại được nguyên vẹn.
- Kênh ngược `POST /poll` + `POST /result` trên bridge **nhúng trong tiến trình
  MCP** (hàng đợi là biến in-memory, không IPC). Máy trạng thái tách riêng ở
  `src/shared/liveChannel.ts` để test được không cần socket.

### Changed

- **Cổng mặc định `3845` → `3846`.** 3845 là cổng Figma Dev Mode MCP — đụng độ là
  trạng thái mặc định với đúng nhóm dùng tool này. Manifest whitelist cả hai.
- **Token gate chuyển sang default-deny, đặt ở đầu router.** Trước đây `tokenOk`
  chỉ được gọi trong nhánh `/export`, mà template gần nhất để copy lại là
  `/health` *không* chặn — endpoint mới rất dễ vô tình để hở. `/result` hở nghĩa
  là tiến trình lạ bơm được design giả vào agent đang sinh code.
- `GET /health` trả thêm tóm tắt trạng thái live.

### Notes — giới hạn đã biết

- **Figma không chạy plugin ở nền.** Panel phải mở trong đúng file; AI không
  đánh thức Figma được. `live_status` cho biết ngay thay vì chờ timeout.
- Sandbox `fetch` **không huỷ được** (`FetchOptions` không có `signal`), nên vòng
  poll dùng self-scheduling + generation counter thay cho `setInterval` +
  AbortController.
- Poll rỗng phải trả **200 kèm body**: `FetchResponse` không có `.body`, và
  `json()` trên 204 rỗng sẽ ném lỗi làm chết vòng lặp ngay tick đầu.
- **Server chưa tự xác thực với plugin.** Tiến trình chiếm cổng trước sẽ nhận
  token và toàn bộ payload. Cần HMAC-SHA256 (sandbox không có `SubtleCrypto`) —
  chưa làm, không nên coi là đã vá.

Vòng lặp "sinh code rồi tự kiểm chứng": ảnh render để agent **nhìn** được thiết kế,
hash để biết design đã đổi ở **đâu**, và cắt bớt payload trùng lặp. Plugin `0.8.0`.

### Added

- **Ảnh render từng màn (phase 3 + raster)**: trước đây chỉ render node
  `≤ 400×400` nên **không màn hình thật nào** lọt qua. Nay fit theo **cả hai
  chiều** về `MAX_PREVIEW_PX` (1600), cho up-scale ≤ 2× với node nhỏ, tự hạ scale
  và thử lại khi PNG vượt trần. Container SECTION/GROUP được render theo **từng
  frame con** (1 ảnh/màn) thay vì một ảnh khổng lồ. Lấy qua
  `figma_bridge_get_raster` — trả về image block nên agent **nhìn thấy** để đối
  chiếu với code nó vừa sinh.
- **`meta.rasterReport`**: `previews[]` (id/name/kích thước/bytes), `imageCount`,
  và `skipped[{key,name,reason}]`. Trước đây ảnh vượt trần bị bỏ **âm thầm**,
  khiến "quá cỡ" trông y hệt "thiết kế không có ảnh".
- **Hash Merkle mỗi node** + `meta.contentHash` / `meta.rootHashes`. Hash của một
  node phủ cả cây con, nên sửa sâu làm đổi hash node đó **và mọi tổ tiên**, trong
  khi nhánh không đổi giữ nguyên hash.
- **Tool `figma_bridge_diff_exports`**: so hai export, trả
  `[{id,name,type,change}]`. Bỏ qua nguyên nhánh có hash trùng và chỉ báo node
  **thực sự** bị sửa (không kể tổ tiên bị đổi hash lây). Không tham số thì so
  export liền trước với `latest`. Export cũ chưa có hash vẫn diff được
  (`hashed:false`).

### Changed

- **Trần ảnh nhúng** `512KB` → `4MB` (base64 phồng ~33%, tối đa 12 ảnh nên vẫn
  nằm trong trần body 64MB của bridge). Ảnh hero cỡ thật trước đây luôn bị loại.
- **`DEFAULT_MAX_NODES`** `8000` → `20000`; một màn 8261 node từng bị cắt mất 6 node.
- **Payload gọn hơn ~22%** (đo trên export thật 11.69 MB), không mất dữ liệu:
  - `text.segments` chỉ xuất khi có **>1 run** hoặc có hyperlink. 3129/3131 node
    text chỉ có đúng 1 run lặp lại y nguyên các trường cấp node (đã đối chiếu
    từng trường: 0 sai khác; `segment.fills` là bản nghèo hơn của `node.fills`,
    vốn đã có `cssColor` + `tokens`). Tiết kiệm ~1.9 MB.
  - `layoutSelf` bỏ giá trị mặc định của Figma: `constraints` MIN/MIN,
    `layoutAlign` INHERIT, `layoutGrow` 0. Đọc thiếu khoá = mặc định. ~0.66 MB.

### Fixed

- Nhãn checkbox raster ghi "tối đa 5 layer gốc" trong khi trần thật là 8 màn +
  12 ảnh nhúng.

### Notes

- **Không** nén `tokens` nhúng trong paint (0.77 MB, lặp ~96 lần/token) dù rất
  cám dỗ: 5/46 token là biến thư viện **remote** không có trong bảng `variables`,
  paint bind qua **alias** có thể không mang màu riêng (`tokens.cssColor` là nơi
  duy nhất có màu đã resolve), và biến non-color chỉ có giá trị trong `value`.
  Đổi ~5% dung lượng lấy nguy cơ mất dữ liệu âm thầm là không đáng.

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
