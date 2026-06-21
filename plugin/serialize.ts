/// <reference types="@figma/plugin-typings" />

export type ExportPhase = 1 | 2 | 3;

export type ExportScope = "selection" | "page";

const PLUGIN_VERSION = "0.4.0";
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_NODES = 8000;
const TEXT_CAP = 8000;

type Counter = { n: number };

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n * 255)));
}

function hex2(n: number): string {
  return clampChannel(n).toString(16).padStart(2, "0");
}

/** Figma color {r,g,b} 0..1 (+ optional a / layer opacity) -> CSS hex or rgba(). */
function cssColor(
  c: { r: number; g: number; b: number; a?: number },
  opacity = 1,
): string {
  const a = (typeof c.a === "number" ? c.a : 1) * opacity;
  if (a >= 0.999) {
    return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  }
  return `rgba(${clampChannel(c.r)}, ${clampChannel(c.g)}, ${clampChannel(c.b)}, ${Math.round(a * 1000) / 1000})`;
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

function serializePaint(
  paint: Paint,
  phase: ExportPhase,
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
  if (!("fills" in node) || node.fills === figma.mixed) {
    return [];
  }
  const fills = node.fills as readonly Paint[];
  return fills.map((p) => serializePaint(p, phase));
}

function serializeStrokes(
  node: GeometryMixin & BlendMixin,
  phase: ExportPhase,
): unknown[] {
  if (!("strokes" in node) || node.strokes === figma.mixed) {
    return [];
  }
  const strokes = node.strokes as readonly Paint[];
  return strokes.map((p) => serializePaint(p, phase));
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

  if ("constraints" in node) {
    o.constraints = (node as ConstraintMixin).constraints;
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
    o.layoutGrow = ln.layoutGrow;
    o.layoutAlign = ln.layoutAlign;
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

/** Per-range text styling so bold/colored/sized runs survive (vs. node-level "mixed"). */
function styledTextSegments(node: TextNode): unknown[] {
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
    o.segments = styledTextSegments(node);
  }
  return o;
}

function serializeEffects(node: BlendMixin, phase: ExportPhase): unknown[] {
  if (!("effects" in node) || node.effects === figma.mixed) {
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

type RawVar = {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
};
type RawCol = { id: string; name: string; defaultModeId: string };
type VarSnapshot = { collections: unknown[]; variables: unknown[] };

function isAlias(v: unknown): v is { type: "VARIABLE_ALIAS"; id: string } {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (v as { id?: unknown }).id === "string"
  );
}

/** Resolve a variable to its default-mode value, following alias chains. */
function resolveVar(
  id: string,
  varsById: Map<string, RawVar>,
  colsById: Map<string, RawCol>,
  depth = 0,
): { value: unknown; cssColor?: string } | null {
  if (depth > 8) {
    return null;
  }
  const v = varsById.get(id);
  if (!v) {
    return null;
  }
  const col = colsById.get(v.variableCollectionId);
  const modeId =
    col && col.defaultModeId in v.valuesByMode
      ? col.defaultModeId
      : Object.keys(v.valuesByMode)[0];
  const val = modeId ? v.valuesByMode[modeId] : undefined;
  if (isAlias(val)) {
    return resolveVar(val.id, varsById, colsById, depth + 1);
  }
  const out: { value: unknown; cssColor?: string } = { value: val };
  if (
    v.resolvedType === "COLOR" &&
    val &&
    typeof val === "object" &&
    "r" in (val as Record<string, unknown>)
  ) {
    out.cssColor = cssColor(
      val as { r: number; g: number; b: number; a?: number },
    );
  }
  return out;
}

/** Collect every variable id nested under a value (alias objects). */
function collectVarIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) {
      collectVarIds(v, into);
    }
    return;
  }
  if (isAlias(value)) {
    into.add(value.id);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectVarIds(v, into);
    }
  }
}

/**
 * Attach resolved `tokens` onto paints that bind variables, collect every
 * referenced variable id, and return a COMPACT token table (referenced-only,
 * with default-mode value + cssColor) to replace the full variable dump.
 */
function resolveTokens(roots: unknown[], snapshot: VarSnapshot): VarSnapshot {
  const rawVars = snapshot.variables as RawVar[];
  const rawCols = snapshot.collections as RawCol[];
  const varsById = new Map(rawVars.map((v) => [v.id, v] as const));
  const colsById = new Map(rawCols.map((c) => [c.id, c] as const));
  const referenced = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) {
        walk(n);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    const obj = node as Record<string, unknown>;
    const bv = obj.boundVariables;
    if (bv && typeof bv === "object") {
      const tokens: Record<string, unknown> = {};
      for (const [field, ref] of Object.entries(bv as Record<string, unknown>)) {
        if (typeof ref === "string") {
          referenced.add(ref);
          const v = varsById.get(ref);
          const r = resolveVar(ref, varsById, colsById);
          tokens[field] = {
            id: ref,
            name: v?.name,
            collection: v
              ? colsById.get(v.variableCollectionId)?.name
              : undefined,
            value: r?.value,
            cssColor: r?.cssColor,
          };
        } else {
          collectVarIds(ref, referenced);
        }
      }
      if (Object.keys(tokens).length > 0) {
        obj.tokens = tokens;
      }
    }
    for (const v of Object.values(obj)) {
      walk(v);
    }
  };
  for (const r of roots) {
    walk(r);
  }

  // Pull in alias targets of referenced variables until the set is stable.
  for (let pass = 0; pass < 16; pass++) {
    const before = referenced.size;
    for (const id of [...referenced]) {
      const v = varsById.get(id);
      if (!v) {
        continue;
      }
      for (const val of Object.values(v.valuesByMode)) {
        collectVarIds(val, referenced);
      }
    }
    if (referenced.size === before) {
      break;
    }
  }

  const variables = rawVars
    .filter((v) => referenced.has(v.id))
    .map((v) => {
      const r = resolveVar(v.id, varsById, colsById);
      return {
        id: v.id,
        name: v.name,
        resolvedType: v.resolvedType,
        collection: colsById.get(v.variableCollectionId)?.name,
        variableCollectionId: v.variableCollectionId,
        value: r?.value,
        cssColor: r?.cssColor,
        valuesByMode: v.valuesByMode,
      };
    });
  const usedCols = new Set(variables.map((v) => v.variableCollectionId));
  const collections = (snapshot.collections as Array<{ id: string }>).filter(
    (c) => usedCols.has(c.id),
  );
  return { collections, variables };
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
    node.fillStyleId !== figma.mixed &&
    node.fillStyleId
  ) {
    o.fillStyleId = node.fillStyleId;
  }
  if (
    "strokeStyleId" in node &&
    node.strokeStyleId !== figma.mixed &&
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
    return {
      id: node.id,
      type: node.type,
      name: node.name,
      omitted: true,
      reason: "maxNodes",
    };
  }
  if (depth > maxDepth) {
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

/** Gather unique imageHash values from IMAGE paints in the serialized tree. */
function collectImageHashes(roots: unknown[]): string[] {
  const out = new Set<string>();
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
    if (Array.isArray(obj.fills)) {
      for (const f of obj.fills) {
        if (
          f &&
          typeof f === "object" &&
          (f as Record<string, unknown>).type === "IMAGE"
        ) {
          const h = (f as Record<string, unknown>).imageHash;
          if (typeof h === "string") {
            out.add(h);
          }
        }
      }
    }
    for (const v of Object.values(obj)) {
      visit(v);
    }
  };
  for (const r of roots) {
    visit(r);
  }
  return [...out];
}

export async function buildExportPayload(opts: {
  phase: ExportPhase;
  scope: ExportScope;
  includeRaster: boolean;
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

  const counter: Counter = { n: 0 };
  const rasters: Record<string, string> = {};

  if (opts.phase >= 3 && opts.includeRaster && opts.scope === "selection") {
    let c = 0;
    for (const n of rootsInput) {
      if (c >= 5) {
        break;
      }
      if ("exportAsync" in n && n.visible) {
        const b = n.absoluteBoundingBox;
        if (
          b &&
          b.width * b.height <= 400 * 400 &&
          b.width >= 1 &&
          b.height >= 1
        ) {
          try {
            const bytes = await n.exportAsync({
              format: "PNG",
              constraint: { type: "SCALE", value: 1 },
            });
            rasters[n.id] = uint8ToBase64(bytes);
            c++;
          } catch {
            /* raster optional */
          }
        }
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
  if (opts.phase >= 3 && opts.includeRaster) {
    const hashes = collectImageHashes(roots).slice(0, 12);
    for (const h of hashes) {
      if (rasters[h]) {
        continue;
      }
      try {
        const img = figma.getImageByHash(h);
        if (!img) {
          continue;
        }
        const bytes = await img.getBytesAsync();
        if (bytes.length > 512 * 1024) {
          continue;
        }
        rasters[h] = uint8ToBase64(bytes);
      } catch {
        /* image bytes optional */
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
    maxDepth,
    maxNodes,
  };

  const payload: Record<string, unknown> = { meta, roots };

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

  if (opts.phase >= 3 && Object.keys(rasters).length > 0) {
    payload.rasters = rasters;
  }

  return payload;
}
