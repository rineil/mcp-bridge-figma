/// <reference types="@figma/plugin-typings" />

import {
  buildNodeCss,
  collectImageHashes,
  cssColor,
  cssGradient,
  cssLetterSpacing,
  cssLineHeight,
  attachHashes,
  cssTextDecoration,
  cssTextTransform,
  fitPreviewScale,
  hashString,
  resolveTokens,
} from "./pure";

export type ExportPhase = 1 | 2 | 3;

export type ExportScope = "selection" | "page";

export const PLUGIN_VERSION = "0.8.0";
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_NODES = 20000;
// Per-image ceiling for IMAGE fill bytes. Base64 inflates ~33% and up to 12
// images ship per export, so this stays well inside the bridge's 64MB body cap.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Visual-reference renders: longest side of a preview PNG. 1600 keeps UI text
// legible to a vision model while staying a few hundred KB per screen.
const MAX_PREVIEW_PX = 1600;
const MAX_PREVIEWS = 8;
// Small components may be scaled up, but never past 2x — beyond that a PNG only
// costs bytes without adding detail.
const MAX_PREVIEW_SCALE = 2;
const TEXT_CAP = 8000;
// Assets = nodes the designer marked with Export settings in Figma. Icons come
// in the dozens, so the cap is higher than previews; an icon SVG is a few KB, so
// a fat cap here only catches a whole illustration exported by mistake.
const MAX_ASSETS = 80;
const MAX_SVG_CHARS = 512 * 1024;

type Counter = { n: number; omitted: number };

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * Runtime guard for figma.mixed. Typed as `unknown` so comparisons don't trip
 * TS2367 on properties the typings model as never-mixed (fills/strokes/effects/
 * strokeStyleId) even though they can be figma.mixed at runtime.
 */
function isMixed(v: unknown): boolean {
  return v === figma.mixed;
}

function bbox(node: SceneNode): {
  x: number;
  y: number;
  width: number;
  height: number;
  space: "absolute" | "relative";
} | null {
  const b = node.absoluteBoundingBox;
  if (b) {
    return { x: b.x, y: b.y, width: b.width, height: b.height, space: "absolute" };
  }
  if ("width" in node && "height" in node) {
    // Fallback: x/y here are PARENT-RELATIVE (LayoutMixin), unlike the
    // page-absolute absoluteBoundingBox above — flag the space so consumers
    // never mix the two coordinate systems.
    const g = node as LayoutMixin;
    return {
      x: "x" in node ? (node as LayoutMixin).x : 0,
      y: "y" in node ? (node as LayoutMixin).y : 0,
      width: g.width,
      height: g.height,
      space: "relative",
    };
  }
  return null;
}

function serializeBoundVars(bv: {
  color?: VariableAlias;
  r?: VariableAlias;
  g?: VariableAlias;
  b?: VariableAlias;
  a?: VariableAlias;
}): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of Object.keys(bv) as (keyof typeof bv)[]) {
    const a = bv[k];
    if (a && typeof a === "object" && "id" in a) {
      o[String(k)] = a.id;
    }
  }
  return o;
}

function nodeDims(node: object): { width: number; height: number } {
  const n = node as Record<string, unknown>;
  return {
    width: typeof n.width === "number" ? n.width : 1,
    height: typeof n.height === "number" ? n.height : 1,
  };
}

function serializePaint(
  paint: Paint,
  phase: ExportPhase,
  dims?: { width: number; height: number },
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    type: paint.type,
    visible: paint.visible !== false,
  };
  if (paint.type === "SOLID") {
    o.opacity = paint.opacity;
    if (paint.color) {
      o.color = paint.color;
      o.cssColor = cssColor(paint.color, paint.opacity ?? 1);
    }
    if (phase >= 2 && "boundVariables" in paint && paint.boundVariables) {
      o.boundVariables = serializeBoundVars(
        paint.boundVariables as Parameters<typeof serializeBoundVars>[0],
      );
    }
  } else if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    o.gradientStops =
      paint.gradientStops?.map((s) => ({
        position: s.position,
        color: s.color,
        cssColor: cssColor(s.color),
      })) ?? [];
    o.gradientTransform = paint.gradientTransform;
    const grad = cssGradient(o, dims?.width, dims?.height);
    if (grad) {
      o.cssGradient = grad;
    }
    if (phase >= 2 && "boundVariables" in paint && paint.boundVariables) {
      o.boundVariables = JSON.parse(
        JSON.stringify(paint.boundVariables),
      ) as unknown;
    }
  } else if (paint.type === "IMAGE") {
    o.imageHash = paint.imageHash ?? null;
    o.scaleMode = paint.scaleMode;
  }
  return o;
}

function serializeFills(
  node: GeometryMixin & BlendMixin,
  phase: ExportPhase,
): unknown[] {
  if (!("fills" in node) || isMixed(node.fills)) {
    return [];
  }
  const fills = node.fills as readonly Paint[];
  const dims = nodeDims(node);
  return fills.map((p) => serializePaint(p, phase, dims));
}

function serializeStrokes(
  node: GeometryMixin & BlendMixin,
  phase: ExportPhase,
): unknown[] {
  if (!("strokes" in node) || isMixed(node.strokes)) {
    return [];
  }
  const strokes = node.strokes as readonly Paint[];
  const dims = nodeDims(node);
  return strokes.map((p) => serializePaint(p, phase, dims));
}

/** Map Figma auto-layout onto a ready-to-use flexbox style block. */
function autoLayoutCss(n: FrameNode): Record<string, unknown> | undefined {
  if (n.layoutMode === "NONE") {
    return undefined;
  }
  const justify: Record<string, string> = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end",
    SPACE_BETWEEN: "space-between",
  };
  const align: Record<string, string> = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end",
    BASELINE: "baseline",
  };
  const css: Record<string, unknown> = {
    display: "flex",
    flexDirection: n.layoutMode === "HORIZONTAL" ? "row" : "column",
    justifyContent: justify[n.primaryAxisAlignItems] ?? "flex-start",
    alignItems: align[n.counterAxisAlignItems] ?? "flex-start",
  };
  if (n.itemSpacing) {
    css.gap = `${n.itemSpacing}px`;
  }
  if (n.paddingTop || n.paddingRight || n.paddingBottom || n.paddingLeft) {
    css.padding = `${n.paddingTop}px ${n.paddingRight}px ${n.paddingBottom}px ${n.paddingLeft}px`;
  }
  if ("layoutWrap" in n && n.layoutWrap === "WRAP") {
    css.flexWrap = "wrap";
  }
  return css;
}

function layoutExtras(node: SceneNode): Record<string, unknown> | undefined {
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "INSTANCE" &&
    node.type !== "COMPONENT_SET"
  ) {
    return undefined;
  }
  const n = node as FrameNode;
  const o: Record<string, unknown> = {
    layoutMode: n.layoutMode,
    primaryAxisSizingMode: n.primaryAxisSizingMode,
    counterAxisSizingMode: n.counterAxisSizingMode,
    primaryAxisAlignItems: n.primaryAxisAlignItems,
    counterAxisAlignItems: n.counterAxisAlignItems,
    paddingLeft: n.paddingLeft,
    paddingRight: n.paddingRight,
    paddingTop: n.paddingTop,
    paddingBottom: n.paddingBottom,
    itemSpacing: n.itemSpacing,
    clipsContent: n.clipsContent,
  };
  if ("layoutWrap" in n) {
    o.layoutWrap = n.layoutWrap;
  }
  if (n.layoutGrids && n.layoutGrids.length > 0) {
    o.layoutGrids = n.layoutGrids;
  }
  const css = autoLayoutCss(n);
  if (css) {
    o.css = css;
  }
  return o;
}

/**
 * Per-node responsive/sizing info: layout constraints (for absolutely-positioned
 * children) and modern auto-layout child sizing (FILL/HUG/FIXED, grow, align,
 * min/max). These live on the child node, not the parent.
 */
function layoutSelf(node: SceneNode): Record<string, unknown> | undefined {
  const o: Record<string, unknown> = {};

  // Figma's own defaults are omitted rather than restated on every node: MIN/MIN
  // constraints, INHERIT align and grow 0 accounted for ~660KB of pure noise in
  // an 8k-node export. A reader treats an absent key as the default.
  if ("constraints" in node) {
    const c = (node as ConstraintMixin).constraints;
    if (c && (c.horizontal !== "MIN" || c.vertical !== "MIN")) {
      o.constraints = c;
    }
  }

  // layoutSizing*/grow/align are only valid to read when the node participates
  // in auto-layout (is itself an auto-layout frame, or a direct child of one).
  const parent = node.parent;
  const parentAuto =
    !!parent &&
    "layoutMode" in parent &&
    (parent as BaseFrameMixin).layoutMode !== "NONE";
  const selfAuto =
    "layoutMode" in node && (node as BaseFrameMixin).layoutMode !== "NONE";
  if ((parentAuto || selfAuto) && "layoutSizingHorizontal" in node) {
    const ln = node as LayoutMixin;
    o.layoutSizingHorizontal = ln.layoutSizingHorizontal;
    o.layoutSizingVertical = ln.layoutSizingVertical;
    if (ln.layoutGrow !== 0) {
      o.layoutGrow = ln.layoutGrow;
    }
    if (ln.layoutAlign !== "INHERIT") {
      o.layoutAlign = ln.layoutAlign;
    }
  }

  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    if (k in node) {
      const v = (node as unknown as Record<string, unknown>)[k];
      if (v != null) {
        o[k] = v;
      }
    }
  }

  return Object.keys(o).length ? o : undefined;
}

/**
 * Vector path geometry for shape nodes (icons, illustrations). fillGeometry is a
 * list of SVG-path strings an agent can re-emit as inline <path d="…">.
 */
function vectorGeometry(node: SceneNode): Record<string, unknown> | undefined {
  if (
    node.type !== "VECTOR" &&
    node.type !== "BOOLEAN_OPERATION" &&
    node.type !== "LINE" &&
    node.type !== "POLYGON" &&
    node.type !== "STAR"
  ) {
    return undefined;
  }
  const o: Record<string, unknown> = {};
  if ("fillGeometry" in node) {
    const g = node as GeometryMixin;
    o.fillGeometry = g.fillGeometry;
    if (g.strokeGeometry && g.strokeGeometry.length > 0) {
      o.strokeGeometry = g.strokeGeometry;
    }
  }
  if (node.type === "BOOLEAN_OPERATION") {
    o.booleanOperation = node.booleanOperation;
  }
  return Object.keys(o).length ? o : undefined;
}

type TextSegment = { hyperlink?: unknown; [k: string]: unknown };

/** Per-range text styling so bold/colored/sized runs survive (vs. node-level "mixed"). */
function styledTextSegments(node: TextNode): TextSegment[] {
  try {
    const segs = node.getStyledTextSegments([
      "fontName",
      "fontSize",
      "fontWeight",
      "textCase",
      "textDecoration",
      "lineHeight",
      "letterSpacing",
      "fills",
      "textStyleId",
      "fillStyleId",
      "hyperlink",
    ]);
    return segs.map((s) => ({
      start: s.start,
      end: s.end,
      characters:
        s.characters.length > TEXT_CAP
          ? `${s.characters.slice(0, TEXT_CAP)}…`
          : s.characters,
      fontName: s.fontName,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      textCase: s.textCase,
      textDecoration: s.textDecoration,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      cssLineHeight: cssLineHeight(s.lineHeight),
      cssLetterSpacing: cssLetterSpacing(s.letterSpacing),
      cssTextTransform: cssTextTransform(s.textCase),
      cssTextDecoration: cssTextDecoration(s.textDecoration),
      fills: s.fills,
      textStyleId: s.textStyleId,
      fillStyleId: s.fillStyleId,
      hyperlink: s.hyperlink,
    }));
  } catch {
    return [];
  }
}

function textExtras(
  node: TextNode,
  phase: ExportPhase,
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    characters:
      node.characters.length > TEXT_CAP
        ? `${node.characters.slice(0, TEXT_CAP)}…`
        : node.characters,
    textTruncated: node.characters.length > TEXT_CAP,
    fontSize: node.fontSize === figma.mixed ? "mixed" : node.fontSize,
    fontName: node.fontName === figma.mixed ? "mixed" : node.fontName,
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
  };
  if (phase >= 2) {
    o.lineHeight = node.lineHeight === figma.mixed ? "mixed" : node.lineHeight;
    o.letterSpacing =
      node.letterSpacing === figma.mixed ? "mixed" : node.letterSpacing;
    o.textCase = node.textCase === figma.mixed ? "mixed" : node.textCase;
    o.textDecoration =
      node.textDecoration === figma.mixed ? "mixed" : node.textDecoration;
    o.textStyleId =
      node.textStyleId === figma.mixed ? "mixed" : node.textStyleId;
    o.fontWeight = node.fontWeight === figma.mixed ? "mixed" : node.fontWeight;
    // A single uniform run repeats what the node-level text fields above already
    // say (verified field-by-field against a real 8k-node export: zero divergence,
    // and segment.fills is the poorer twin of node.fills, which carries cssColor
    // plus resolved tokens). Only emit runs when they actually differ.
    const segs = styledTextSegments(node);
    if (segs.length > 1 || segs.some((s) => s.hyperlink)) {
      o.segments = segs;
    }
    // CSS-ready conversions of the (non-mixed) node-level text props.
    const clh = cssLineHeight(o.lineHeight);
    if (clh) {
      o.cssLineHeight = clh;
    }
    const cls = cssLetterSpacing(o.letterSpacing);
    if (cls) {
      o.cssLetterSpacing = cls;
    }
    const ctt = cssTextTransform(o.textCase);
    if (ctt) {
      o.cssTextTransform = ctt;
    }
    const ctd = cssTextDecoration(o.textDecoration);
    if (ctd) {
      o.cssTextDecoration = ctd;
    }
  }
  return o;
}

function serializeEffects(node: BlendMixin, phase: ExportPhase): unknown[] {
  if (!("effects" in node) || isMixed(node.effects)) {
    return [];
  }
  const effects = node.effects as readonly Effect[];
  if (phase < 2) {
    return effects.map((e) => ({ type: e.type, visible: e.visible !== false }));
  }
  return effects.map((e) => {
    const base: Record<string, unknown> = {
      type: e.type,
      visible: e.visible !== false,
    };
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      base.color = e.color;
      base.cssColor = cssColor(e.color);
      base.offset = e.offset;
      base.radius = e.radius;
      base.spread = e.spread;
      base.blendMode = e.blendMode;
    } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      base.radius = e.radius;
    }
    return base;
  });
}

async function variableSnapshot(): Promise<{
  collections: unknown[];
  variables: unknown[];
} | null> {
  // Async variants are required: the synchronous getLocalVariableCollections/
  // getLocalVariables throw under manifest documentAccess:"dynamic-page".
  // The try/catch remains only for editors without a variables API (e.g. FigJam).
  try {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    return {
      collections: cols.map((c) => ({
        id: c.id,
        name: c.name,
        defaultModeId: c.defaultModeId,
        modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
        variableIds: c.variableIds,
      })),
      variables: variables.map((v) => ({
        id: v.id,
        name: v.name,
        resolvedType: v.resolvedType,
        variableCollectionId: v.variableCollectionId,
        valuesByMode: v.valuesByMode,
        remote: v.remote,
      })),
    };
  } catch {
    return null;
  }
}

function styleIds(
  node: SceneNode,
  phase: ExportPhase,
): Record<string, unknown> | undefined {
  if (phase < 2) {
    return undefined;
  }
  const o: Record<string, unknown> = {};
  if (
    "fillStyleId" in node &&
    !isMixed(node.fillStyleId) &&
    node.fillStyleId
  ) {
    o.fillStyleId = node.fillStyleId;
  }
  if (
    "strokeStyleId" in node &&
    !isMixed(node.strokeStyleId) &&
    node.strokeStyleId
  ) {
    o.strokeStyleId = node.strokeStyleId;
  }
  if ("effectStyleId" in node && node.effectStyleId) {
    o.effectStyleId = node.effectStyleId;
  }
  return Object.keys(o).length ? o : undefined;
}

async function componentExtras(
  node: SceneNode,
  phase: ExportPhase,
): Promise<Record<string, unknown> | undefined> {
  if (phase < 3) {
    return undefined;
  }
  if (node.type === "INSTANCE") {
    const inst = node as InstanceNode;
    // getMainComponentAsync: the synchronous mainComponent getter throws
    // under manifest documentAccess:"dynamic-page".
    const main = await inst.getMainComponentAsync();
    return {
      variantProperties: inst.variantProperties,
      componentProperties: inst.componentProperties,
      // Which sub-nodes diverge from the main component, and on which fields,
      // so the agent can apply per-instance overrides to a shared definition.
      overrides: inst.overrides,
      mainComponent: main
        ? {
            id: main.id,
            name: main.name,
            key: "key" in main ? main.key : undefined,
            remote: main.remote,
          }
        : null,
    };
  }
  if (node.type === "COMPONENT_SET") {
    const cs = node as ComponentSetNode;
    return {
      componentPropertyDefinitions: cs.componentPropertyDefinitions,
    };
  }
  if (node.type === "COMPONENT") {
    const c = node as ComponentNode;
    return {
      remote: c.remote,
      componentPropertyDefinitions: c.componentPropertyDefinitions,
    };
  }
  return undefined;
}

function getChildren(node: SceneNode): readonly SceneNode[] {
  if ("children" in node) {
    return (node as ChildrenMixin).children;
  }
  return [];
}

export async function serializeNode(
  node: SceneNode,
  phase: ExportPhase,
  counter: Counter,
  depth: number,
  maxDepth: number,
  maxNodes: number,
): Promise<unknown> {
  counter.n += 1;
  if (counter.n > maxNodes) {
    counter.omitted += 1;
    return {
      id: node.id,
      type: node.type,
      name: node.name,
      omitted: true,
      reason: "maxNodes",
    };
  }
  if (depth > maxDepth) {
    counter.omitted += 1;
    return {
      id: node.id,
      type: node.type,
      name: node.name,
      omitted: true,
      reason: "maxDepth",
    };
  }

  const base: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
    visible: node.visible,
    locked: "locked" in node ? node.locked : undefined,
    opacity: "opacity" in node ? node.opacity : undefined,
    blendMode: "blendMode" in node ? node.blendMode : undefined,
    bbox: bbox(node),
  };

  // Parent-relative box: CSS-ready left/top/width/height for absolute children,
  // so consumers don't have to subtract the parent's absolute origin themselves.
  const abs = node.absoluteBoundingBox;
  const par = node.parent;
  const parAbs =
    par && "absoluteBoundingBox" in par
      ? (par as { absoluteBoundingBox: Rect | null }).absoluteBoundingBox
      : null;
  if (abs && parAbs) {
    base.rel = {
      x: abs.x - parAbs.x,
      y: abs.y - parAbs.y,
      width: abs.width,
      height: abs.height,
    };
  }

  if ("isMask" in node && node.isMask) {
    base.isMask = true;
    if ("maskType" in node) {
      base.maskType = (node as { maskType?: string }).maskType;
    }
  }

  if ("rotation" in node) {
    base.rotation = node.rotation;
  }
  if ("cornerRadius" in node && node.cornerRadius !== figma.mixed) {
    base.cornerRadius = node.cornerRadius;
  } else if ("topLeftRadius" in node) {
    const r = node as RectangleCornerMixin;
    base.rectangleCornerRadii = [
      r.topLeftRadius,
      r.topRightRadius,
      r.bottomRightRadius,
      r.bottomLeftRadius,
    ];
  }

  if ("fills" in node) {
    base.fills = serializeFills(node as GeometryMixin & BlendMixin, phase);
  }
  if ("strokes" in node) {
    base.strokes = serializeStrokes(node as GeometryMixin & BlendMixin, phase);
    base.strokeWeight =
      "strokeWeight" in node && node.strokeWeight !== figma.mixed
        ? node.strokeWeight
        : undefined;
    base.strokeAlign = "strokeAlign" in node ? node.strokeAlign : undefined;
    if ("dashPattern" in node) {
      const s = node as MinimalStrokesMixin;
      if (s.dashPattern.length > 0) {
        base.dashPattern = s.dashPattern;
      }
      if ("strokeCap" in s && s.strokeCap !== figma.mixed) {
        base.strokeCap = s.strokeCap;
      }
      if (s.strokeJoin !== figma.mixed) {
        base.strokeJoin = s.strokeJoin;
      }
    }
  }

  const le = layoutExtras(node);
  if (le) {
    base.layout = le;
  }

  const ls = layoutSelf(node);
  if (ls) {
    base.layoutSelf = ls;
  }

  if (node.type === "TEXT") {
    base.text = textExtras(node as TextNode, phase);
  }

  base.effects = serializeEffects(node as BlendMixin, phase);

  const sid = styleIds(node, phase);
  if (sid) {
    base.styleRefs = sid;
  }

  const comp = await componentExtras(node, phase);
  if (comp) {
    base.component = comp;
  }

  const vec = vectorGeometry(node);
  if (vec) {
    base.geometry = vec;
  }

  // Consolidated, ready-to-apply CSS block. Absolute positioning only when the
  // node is NOT a child of an auto-layout frame (otherwise flex handles it).
  const cssParent = node.parent;
  const parentIsAuto =
    !!cssParent &&
    "layoutMode" in cssParent &&
    (cssParent as BaseFrameMixin).layoutMode !== "NONE";
  const nodeCss = buildNodeCss(base, { absolute: !parentIsAuto });
  if (nodeCss) {
    base.css = nodeCss;
  }

  const kids = getChildren(node);
  if (kids.length > 0) {
    // Sequential await preserves the depth-first maxNodes/maxDepth counting order.
    const children: unknown[] = [];
    for (const c of kids) {
      children.push(
        await serializeNode(c, phase, counter, depth + 1, maxDepth, maxNodes),
      );
    }
    base.children = children;
  }

  return base;
}

/** Unique LOCAL main-component ids referenced by INSTANCE nodes in the serialized tree. */
function collectMainComponentIds(roots: unknown[]): string[] {
  const ids = new Set<string>();
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) {
        visit(x);
      }
      return;
    }
    if (!n || typeof n !== "object") {
      return;
    }
    const obj = n as Record<string, unknown>;
    const comp = obj.component as Record<string, unknown> | undefined;
    const main = comp?.mainComponent as Record<string, unknown> | undefined;
    if (main && typeof main.id === "string" && main.remote === false) {
      ids.add(main.id);
    }
    for (const v of Object.values(obj)) {
      visit(v);
    }
  };
  for (const r of roots) {
    visit(r);
  }
  return [...ids];
}

/** A SECTION/GROUP is a container; its frame-like children are the screens. */
function isScreenLike(n: SceneNode): boolean {
  return (
    n.type === "FRAME" ||
    n.type === "COMPONENT" ||
    n.type === "COMPONENT_SET" ||
    n.type === "INSTANCE"
  );
}

/**
 * Nodes worth rendering as a visual reference. Rendering a SECTION gives one
 * huge image of everything; rendering its frame children gives one image per
 * screen, which is what an agent needs to diff generated UI against the design.
 */
function collectPreviewTargets(roots: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  for (const r of roots) {
    if ((r.type === "SECTION" || r.type === "GROUP") && "children" in r) {
      const kids = r.children.filter(isScreenLike);
      if (kids.length > 0) {
        out.push(...kids);
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

export type PreviewInfo = {
  id: string;
  name: string;
  width: number;
  height: number;
  scale: number;
  bytes: number;
};
export type RasterSkip = { key: string; name: string; reason: string };

export type AssetFormat = "svg" | "png" | "jpg" | "pdf";

export type AssetInfo = {
  id: string;
  name: string;
  type: string;
  formats: AssetFormat[];
  /** SVG is inline text — an agent re-emits it as <svg> directly, no fetch. */
  svg?: string;
  /** Binary formats live in `rasters`; these are the keys to fetch them by. */
  rasterKeys?: Partial<Record<"png" | "jpg" | "pdf", string>>;
};

/**
 * Nodes the designer marked for export in Figma's right-panel Export section
 * (`exportSettings` non-empty). This is the "theo figma hiện có" set — the icons
 * and assets already intended for handoff, not every vector we could guess at.
 */
function collectAssetTargets(roots: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const seen = new Set<string>();
  const visit = (n: SceneNode): void => {
    if (
      "exportSettings" in n &&
      n.exportSettings.length > 0 &&
      "exportAsync" in n &&
      !seen.has(n.id)
    ) {
      seen.add(n.id);
      out.push(n);
    }
    if ("children" in n) {
      for (const c of n.children) {
        visit(c);
      }
    }
  };
  for (const r of roots) {
    visit(r);
  }
  return out;
}

export async function buildExportPayload(opts: {
  phase: ExportPhase;
  scope: ExportScope;
  includeRaster: boolean;
  /** Formats to export designer-marked asset nodes in. Empty = feature off. */
  assetFormats?: AssetFormat[];
  maxDepth?: number;
  maxNodes?: number;
}): Promise<Record<string, unknown>> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const rootsInput: SceneNode[] =
    opts.scope === "page"
      ? [...figma.currentPage.children]
      : [...figma.currentPage.selection];

  if (opts.scope === "selection" && rootsInput.length === 0) {
    throw new Error(
      "Chọn ít nhất một layer trên canvas, hoặc đổi scope sang page.",
    );
  }

  const counter: Counter = { n: 0, omitted: 0 };
  const rasters: Record<string, string> = {};

  const previews: PreviewInfo[] = [];
  const rasterSkipped: RasterSkip[] = [];

  // Visual-reference renders: one PNG per screen so an agent can SEE the design
  // and diff it against the code it generated from the JSON. Scale is fitted to
  // the node so a 1920x1000 screen and a 64x64 icon both come out usable.
  if (opts.phase >= 3 && opts.includeRaster) {
    for (const n of collectPreviewTargets(rootsInput)) {
      if (previews.length >= MAX_PREVIEWS) {
        rasterSkipped.push({
          key: n.id,
          name: n.name,
          reason: `preview cap ${MAX_PREVIEWS} reached`,
        });
        continue;
      }
      if (!("exportAsync" in n) || !n.visible) {
        rasterSkipped.push({
          key: n.id,
          name: n.name,
          reason: n.visible ? "node cannot be exported" : "node is hidden",
        });
        continue;
      }
      const b = n.absoluteBoundingBox;
      if (!b || b.width < 1 || b.height < 1) {
        rasterSkipped.push({
          key: n.id,
          name: n.name,
          reason: "no bounding box",
        });
        continue;
      }
      // Fit inside MAX_PREVIEW_PX on BOTH axes so a very tall frame cannot slip
      // through on width alone; halve and retry when the PNG lands over budget.
      let scale = fitPreviewScale(
        b.width,
        b.height,
        MAX_PREVIEW_PX,
        MAX_PREVIEW_SCALE,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        let bytes: Uint8Array;
        try {
          bytes = await n.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: scale },
          });
        } catch (e) {
          rasterSkipped.push({
            key: n.id,
            name: n.name,
            reason: `render failed: ${e instanceof Error ? e.message : String(e)}`,
          });
          break;
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
          if (attempt === 2) {
            rasterSkipped.push({
              key: n.id,
              name: n.name,
              reason: `render still ${bytes.length} bytes at scale ${scale.toFixed(3)} (cap ${MAX_IMAGE_BYTES})`,
            });
            break;
          }
          scale = scale / 2;
          continue;
        }
        rasters[n.id] = uint8ToBase64(bytes);
        previews.push({
          id: n.id,
          name: n.name,
          width: Math.round(b.width * scale),
          height: Math.round(b.height * scale),
          scale: Number(scale.toFixed(3)),
          bytes: bytes.length,
        });
        break;
      }
    }
  }

  const roots: unknown[] = [];
  for (const n of rootsInput) {
    roots.push(
      await serializeNode(n, opts.phase, counter, 0, maxDepth, maxNodes),
    );
  }

  // Resolve IMAGE fill bytes so imageHash references become dereferenceable.
  // Opt-in (raster checkbox), capped count + per-image size to bound payload.
  let imageCount = 0;
  if (opts.phase >= 3 && opts.includeRaster) {
    const allHashes = collectImageHashes(roots);
    const hashes = allHashes.slice(0, 12);
    for (const h of allHashes.slice(12)) {
      rasterSkipped.push({
        key: h,
        name: "IMAGE fill",
        reason: "image cap 12 reached",
      });
    }
    for (const h of hashes) {
      if (rasters[h]) {
        continue;
      }
      try {
        const img = figma.getImageByHash(h);
        if (!img) {
          rasterSkipped.push({
            key: h,
            name: "IMAGE fill",
            reason: "hash not resolvable in this file",
          });
          continue;
        }
        const bytes = await img.getBytesAsync();
        if (bytes.length > MAX_IMAGE_BYTES) {
          rasterSkipped.push({
            key: h,
            name: "IMAGE fill",
            reason: `${bytes.length} bytes > cap ${MAX_IMAGE_BYTES}`,
          });
          continue;
        }
        rasters[h] = uint8ToBase64(bytes);
        imageCount++;
      } catch (e) {
        rasterSkipped.push({
          key: h,
          name: "IMAGE fill",
          reason: `read failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  // Assets: export the designer-marked nodes in the user's chosen formats.
  // Independent of phase/raster — an icon sheet is useful even on a phase-1
  // capture. Each requested format is produced from the same node; Figma's
  // exportAsync makes any format from any node, so a user ticking PNG gets PNG
  // even where the node's own Figma preset is SVG.
  const assets: AssetInfo[] = [];
  const assetSkipped: RasterSkip[] = [];
  const assetFormats = opts.assetFormats ?? [];
  if (assetFormats.length > 0) {
    for (const n of collectAssetTargets(rootsInput)) {
      if (assets.length >= MAX_ASSETS) {
        assetSkipped.push({
          key: n.id,
          name: n.name,
          reason: `asset cap ${MAX_ASSETS} reached`,
        });
        continue;
      }
      const info: AssetInfo = {
        id: n.id,
        name: n.name,
        type: n.type,
        formats: [],
      };
      const exportable = n as SceneNode & {
        exportAsync: SceneNode["exportAsync"];
      };
      for (const fmt of assetFormats) {
        try {
          if (fmt === "svg") {
            const svg = await exportable.exportAsync({ format: "SVG_STRING" });
            if (svg.length > MAX_SVG_CHARS) {
              assetSkipped.push({
                key: `${n.id}@svg`,
                name: n.name,
                reason: `svg ${svg.length} chars > cap ${MAX_SVG_CHARS}`,
              });
              continue;
            }
            info.svg = svg;
            info.formats.push("svg");
          } else {
            const bytes =
              fmt === "png"
                ? await exportable.exportAsync({ format: "PNG" })
                : fmt === "jpg"
                  ? await exportable.exportAsync({ format: "JPG" })
                  : await exportable.exportAsync({ format: "PDF" });
            if (bytes.length > MAX_IMAGE_BYTES) {
              assetSkipped.push({
                key: `${n.id}@${fmt}`,
                name: n.name,
                reason: `${bytes.length} bytes > cap ${MAX_IMAGE_BYTES}`,
              });
              continue;
            }
            const key = `${n.id}@${fmt}`;
            rasters[key] = uint8ToBase64(bytes);
            (info.rasterKeys ??= {})[fmt] = key;
            info.formats.push(fmt);
          }
        } catch (e) {
          assetSkipped.push({
            key: `${n.id}@${fmt}`,
            name: n.name,
            reason: `export failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (info.formats.length > 0) {
        assets.push(info);
      }
    }
  }

  const meta: Record<string, unknown> = {
    pluginVersion: PLUGIN_VERSION,
    phase: opts.phase,
    scope: opts.scope,
    exportedAt: new Date().toISOString(),
    fileKey: figma.fileKey ?? null,
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    nodeCount: counter.n,
    omittedCount: counter.omitted,
    maxDepth,
    maxNodes,
  };

  // Surface what raster work actually happened. Skips used to be silent, which
  // read as "the design has no images" when it really meant "over the cap".
  if (opts.phase >= 3 && opts.includeRaster) {
    meta.rasterReport = {
      previews,
      imageCount,
      skipped: rasterSkipped,
      note: "previews[].id are keys for figma_bridge_get_raster: fetch one to see the rendered design and compare it against generated code.",
    };
  }

  // Light index of assets so outline/status can show what's exportable without
  // carrying the SVG text. The bytes/text themselves ride in payload.assets.
  if (assetFormats.length > 0) {
    meta.assetReport = {
      requested: assetFormats,
      count: assets.length,
      assets: assets.map((a) => ({
        id: a.id,
        name: a.name,
        formats: a.formats,
      })),
      skipped: assetSkipped,
      note: "Fetch one with figma_bridge_get_asset {nodeId, format}: svg returns inline markup to re-emit, png/jpg return an image block. Source = nodes marked for Export in Figma.",
    };
  }

  const payload: Record<string, unknown> = { meta, roots };
  if (assets.length > 0) {
    payload.assets = assets;
  }

  if (opts.phase >= 2) {
    const snapshot = await variableSnapshot();
    if (snapshot) {
      try {
        // Replace the full dump with a resolved, referenced-only token table and
        // attach per-paint `tokens`. Fall back to the raw snapshot on any error.
        payload.variables = resolveTokens(roots, snapshot);
      } catch {
        payload.variables = snapshot;
      }
    } else {
      payload.variables = null;
    }
  }

  // Hash last, once the tree is final (tokens resolved), so `hash` describes the
  // design as shipped. Per-node hashes let an agent that generated code from an
  // earlier export find exactly which subtrees moved since — the whole point of
  // knowing a design changed is knowing WHERE.
  const rootHashes = roots.map((r) =>
    attachHashes(r as Record<string, unknown>),
  );
  meta.contentHash = hashString(rootHashes.join(""));
  meta.rootHashes = rootHashes;

  if (opts.phase >= 3 && Object.keys(rasters).length > 0) {
    payload.rasters = rasters;
  }

  // Component registry: serialize each unique LOCAL main component ONCE so the
  // agent reads a canonical definition (via figma_bridge_read_component) and
  // applies per-instance `component.overrides`, instead of duplicating markup.
  if (opts.phase >= 3) {
    const compIds = collectMainComponentIds(roots).slice(0, 40);
    const components: Record<string, unknown> = {};
    for (const id of compIds) {
      try {
        const node = await figma.getNodeByIdAsync(id);
        if (
          node &&
          (node.type === "COMPONENT" || node.type === "COMPONENT_SET")
        ) {
          // Fresh counter so definitions don't eat the main tree's maxNodes budget.
          const defCounter: Counter = { n: 0, omitted: 0 };
          components[id] = await serializeNode(
            node,
            opts.phase,
            defCounter,
            0,
            maxDepth,
            maxNodes,
          );
        }
      } catch {
        /* component definition optional */
      }
    }
    if (Object.keys(components).length > 0) {
      payload.components = components;
    }
  }

  return payload;
}
