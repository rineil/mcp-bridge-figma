/**
 * Deterministic React inline-style JSX skeleton from a serialized export node.
 * Pure (no Figma runtime) so it can be unit-tested. Composes the per-node `css`
 * block + `layout.css` the serializer already produced — it does not re-derive
 * styles. Text -> <span> with text color/font; vector geometry -> inline <svg>;
 * IMAGE fill -> <img data-raster=…>; everything else -> <div>.
 */

export type CodegenNode = Record<string, unknown>;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Topmost visible paint of an array, or undefined. */
function topPaint(paints: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(paints)) {
    return undefined;
  }
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = asObj(paints[i]);
    if (p && p.visible !== false) {
      return p;
    }
  }
  return undefined;
}

/** Merge the node's flexbox layout.css with its visual css block. */
function mergedStyle(node: CodegenNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const layoutCss = asObj(asObj(node.layout)?.css);
  if (layoutCss) {
    Object.assign(out, layoutCss);
  }
  const css = asObj(node.css);
  if (css) {
    Object.assign(out, css);
  }
  return out;
}

export type Framework = "react-inline" | "react-tailwind";

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Map one css declaration to a Tailwind class (nice utility, else arbitrary property). */
function tailwindClass(key: string, value: unknown): string {
  const v = String(value);
  if (key === "display" && v === "flex") {
    return "flex";
  }
  if (key === "flexDirection") {
    return v === "row"
      ? "flex-row"
      : v === "column"
        ? "flex-col"
        : `[flex-direction:${v}]`;
  }
  if (key === "flexWrap" && v === "wrap") {
    return "flex-wrap";
  }
  if (
    key === "position" &&
    (v === "absolute" || v === "relative" || v === "fixed")
  ) {
    return v;
  }
  if (key === "justifyContent") {
    const m: Record<string, string> = {
      "flex-start": "justify-start",
      center: "justify-center",
      "flex-end": "justify-end",
      "space-between": "justify-between",
    };
    return m[v] ?? `[justify-content:${v}]`;
  }
  if (key === "alignItems") {
    const m: Record<string, string> = {
      "flex-start": "items-start",
      center: "items-center",
      "flex-end": "items-end",
      baseline: "items-baseline",
    };
    return m[v] ?? `[align-items:${v}]`;
  }
  // Generic arbitrary-property class: [border-radius:8px], [padding:8px_16px], …
  return `[${camelToKebab(key)}:${v.replace(/\s+/g, "_")}]`;
}

function cssToTailwind(style: Record<string, unknown>): string {
  return Object.entries(style)
    .map(([k, v]) => tailwindClass(k, v))
    .filter(Boolean)
    .join(" ");
}

/** Render the style as a JSX attribute: inline `style={{…}}` or Tailwind `className="…"`. */
function attr(style: Record<string, unknown>, framework: Framework): string {
  if (Object.keys(style).length === 0) {
    return "";
  }
  if (framework === "react-tailwind") {
    const cls = cssToTailwind(style);
    return cls ? ` className="${esc(cls)}"` : "";
  }
  const entries = Object.entries(style).map(([k, v]) =>
    typeof v === "number" ? `${k}: ${v}` : `${k}: "${esc(String(v))}"`,
  );
  return ` style={{ ${entries.join(", ")} }}`;
}

/** Text gets the fill as `color` (not background) plus font properties. */
function textStyle(node: CodegenNode): Record<string, unknown> {
  const style = mergedStyle(node);
  if (typeof style.background === "string") {
    style.color = style.background;
    delete style.background;
  }
  const t = asObj(node.text);
  if (t) {
    const fs = num(t.fontSize);
    if (fs != null) {
      style.fontSize = `${fs}px`;
    }
    const fn = asObj(t.fontName);
    if (fn && typeof fn.family === "string") {
      style.fontFamily = fn.family;
    }
    if (typeof t.fontWeight === "number") {
      style.fontWeight = t.fontWeight;
    }
    if (typeof t.cssLineHeight === "string") {
      style.lineHeight = t.cssLineHeight;
    }
    if (typeof t.cssLetterSpacing === "string") {
      style.letterSpacing = t.cssLetterSpacing;
    }
    if (typeof t.cssTextTransform === "string") {
      style.textTransform = t.cssTextTransform;
    }
    if (typeof t.cssTextDecoration === "string") {
      style.textDecoration = t.cssTextDecoration;
    }
    if (t.textAlignHorizontal === "CENTER") {
      style.textAlign = "center";
    } else if (t.textAlignHorizontal === "RIGHT") {
      style.textAlign = "right";
    }
  }
  return style;
}

function svgFor(node: CodegenNode): string | undefined {
  const fg = asObj(node.geometry)?.fillGeometry;
  if (!Array.isArray(fg) || fg.length === 0) {
    return undefined;
  }
  const box = asObj(node.bbox) ?? asObj(node.rel);
  const w = num(box?.width) ?? 24;
  const h = num(box?.height) ?? 24;
  const fillPaint = topPaint(node.fills);
  const fill =
    fillPaint && typeof fillPaint.cssColor === "string"
      ? fillPaint.cssColor
      : "currentColor";
  const paths = fg
    .map((p) => {
      const d = asObj(p)?.data;
      return typeof d === "string" ? `<path d="${esc(d)}" fill="${fill}" />` : "";
    })
    .join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function imageHashOf(node: CodegenNode): string | undefined {
  const p = topPaint(node.fills);
  if (p && p.type === "IMAGE" && typeof p.imageHash === "string") {
    return p.imageHash;
  }
  return undefined;
}

/**
 * Emit a React JSX tree for a serialized node (depth-limited). `framework` picks
 * inline `style={{…}}` (react-inline) or `className` Tailwind classes
 * (react-tailwind). Returns the JSX as a string; the agent wraps it in a component.
 */
export function codegenNode(
  node: CodegenNode,
  depth = 6,
  indent = 0,
  framework: Framework = "react-inline",
): string {
  const pad = "  ".repeat(indent);
  const name = typeof node.name === "string" ? node.name : "";
  const dataName = name ? ` data-name="${esc(name)}"` : "";

  const svg = svgFor(node);
  if (svg) {
    return `${pad}${svg}`;
  }

  if (node.type === "TEXT") {
    const text = String(asObj(node.text)?.characters ?? "");
    return `${pad}<span${attr(textStyle(node), framework)}${dataName}>{${JSON.stringify(text)}}</span>`;
  }

  const imgHash = imageHashOf(node);
  if (imgHash) {
    return `${pad}<img${attr(mergedStyle(node), framework)}${dataName} data-raster="${esc(imgHash)}" alt="${esc(name)}" />`;
  }

  const sa = attr(mergedStyle(node), framework);
  const kids = Array.isArray(node.children)
    ? (node.children as CodegenNode[])
    : [];
  if (kids.length === 0) {
    return `${pad}<div${sa}${dataName} />`;
  }
  if (depth <= 0) {
    return `${pad}<div${sa}${dataName}>{/* ${kids.length} children omitted (depth) */}</div>`;
  }
  const inner = kids
    .map((c) => codegenNode(c, depth - 1, indent + 1, framework))
    .join("\n");
  return `${pad}<div${sa}${dataName}>\n${inner}\n${pad}</div>`;
}
