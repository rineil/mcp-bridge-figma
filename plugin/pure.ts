/**
 * Figma-free pure helpers used by the serializer. Kept out of serialize.ts so
 * they can be unit-tested without the Figma plugin runtime (no `figma` global).
 */

export function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n * 255)));
}

export function hex2(n: number): string {
  return clampChannel(n).toString(16).padStart(2, "0");
}

/** Figma color {r,g,b} 0..1 (+ optional a / layer opacity) -> CSS hex or rgba(). */
export function cssColor(
  c: { r: number; g: number; b: number; a?: number },
  opacity = 1,
): string {
  const a = (typeof c.a === "number" ? c.a : 1) * opacity;
  if (a >= 0.999) {
    return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  }
  return `rgba(${clampChannel(c.r)}, ${clampChannel(c.g)}, ${clampChannel(c.b)}, ${Math.round(a * 1000) / 1000})`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// --- effects -> CSS ----------------------------------------------------------

/** Compose `box-shadow` from serialized DROP_SHADOW/INNER_SHADOW effects. */
export function cssBoxShadow(effects: unknown): string | undefined {
  if (!Array.isArray(effects)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const e of effects) {
    if (!e || typeof e !== "object") {
      continue;
    }
    const o = e as Record<string, unknown>;
    if (o.visible === false) {
      continue;
    }
    if (o.type !== "DROP_SHADOW" && o.type !== "INNER_SHADOW") {
      continue;
    }
    const off = (o.offset ?? {}) as Record<string, unknown>;
    const x = num(off.x) ?? 0;
    const y = num(off.y) ?? 0;
    const blur = num(o.radius) ?? 0;
    const spread = num(o.spread) ?? 0;
    const color =
      typeof o.cssColor === "string"
        ? o.cssColor
        : o.color && typeof o.color === "object"
          ? cssColor(o.color as { r: number; g: number; b: number; a?: number })
          : "rgba(0, 0, 0, 0.25)";
    const inset = o.type === "INNER_SHADOW" ? "inset " : "";
    parts.push(`${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

/** Map LAYER_BLUR -> filter:blur(), BACKGROUND_BLUR -> backdrop-filter:blur(). */
export function cssBlurFilters(effects: unknown): {
  filter?: string;
  backdropFilter?: string;
} {
  const out: { filter?: string; backdropFilter?: string } = {};
  if (!Array.isArray(effects)) {
    return out;
  }
  for (const e of effects) {
    if (!e || typeof e !== "object") {
      continue;
    }
    const o = e as Record<string, unknown>;
    if (o.visible === false) {
      continue;
    }
    const r = num(o.radius);
    if (r == null) {
      continue;
    }
    if (o.type === "LAYER_BLUR") {
      out.filter = `blur(${r}px)`;
    }
    if (o.type === "BACKGROUND_BLUR") {
      out.backdropFilter = `blur(${r}px)`;
    }
  }
  return out;
}

// --- text -> CSS -------------------------------------------------------------

/** Figma lineHeight {value,unit} -> CSS ('normal' | 'Npx' | unitless ratio). */
export function cssLineHeight(lh: unknown): string | undefined {
  if (!lh || typeof lh !== "object") {
    return undefined;
  }
  const o = lh as Record<string, unknown>;
  if (o.unit === "AUTO") {
    return "normal";
  }
  const v = num(o.value);
  if (v == null) {
    return undefined;
  }
  if (o.unit === "PIXELS") {
    return `${v}px`;
  }
  if (o.unit === "PERCENT") {
    return `${Math.round((v / 100) * 1000) / 1000}`;
  }
  return undefined;
}

/** Figma letterSpacing {value,unit} -> CSS ('Npx' | 'Nem'). */
export function cssLetterSpacing(ls: unknown): string | undefined {
  if (!ls || typeof ls !== "object") {
    return undefined;
  }
  const o = ls as Record<string, unknown>;
  const v = num(o.value);
  if (v == null) {
    return undefined;
  }
  if (o.unit === "PIXELS") {
    return `${v}px`;
  }
  if (o.unit === "PERCENT") {
    return `${Math.round((v / 100) * 1000) / 1000}em`;
  }
  return undefined;
}

export function cssTextTransform(textCase: unknown): string | undefined {
  if (textCase === "UPPER") {
    return "uppercase";
  }
  if (textCase === "LOWER") {
    return "lowercase";
  }
  if (textCase === "TITLE") {
    return "capitalize";
  }
  return undefined;
}

export function cssTextDecoration(td: unknown): string | undefined {
  if (td === "UNDERLINE") {
    return "underline";
  }
  if (td === "STRIKETHROUGH") {
    return "line-through";
  }
  return undefined;
}

// --- gradients -> CSS --------------------------------------------------------

type Mat = number[][];

function invert2x3(m: Mat): Mat | null {
  const a = m[0]?.[0];
  const c = m[0]?.[1];
  const e = m[0]?.[2];
  const b = m[1]?.[0];
  const d = m[1]?.[1];
  const f = m[1]?.[2];
  if ([a, b, c, d, e, f].some((n) => typeof n !== "number")) {
    return null;
  }
  const det = (a as number) * (d as number) - (b as number) * (c as number);
  if (Math.abs(det) < 1e-9) {
    return null;
  }
  const ia = (d as number) / det;
  const ib = -(b as number) / det;
  const ic = -(c as number) / det;
  const id = (a as number) / det;
  const ie = -(ia * (e as number) + ic * (f as number));
  const iff = -(ib * (e as number) + id * (f as number));
  return [
    [ia, ic, ie],
    [ib, id, iff],
  ];
}

function applyMat(m: Mat, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0][0] * x + m[0][1] * y + m[0][2],
    y: m[1][0] * x + m[1][1] * y + m[1][2],
  };
}

/** "color pos%, color pos%, …" from serialized gradient stops. */
export function gradientStopsCss(stops: unknown): string {
  if (!Array.isArray(stops)) {
    return "";
  }
  return stops
    .map((s): string | null => {
      if (!s || typeof s !== "object") {
        return null;
      }
      const o = s as Record<string, unknown>;
      const color =
        typeof o.cssColor === "string"
          ? o.cssColor
          : o.color && typeof o.color === "object"
            ? cssColor(o.color as { r: number; g: number; b: number; a?: number })
            : null;
      if (!color) {
        return null;
      }
      const pos = num(o.position);
      return pos == null ? color : `${color} ${Math.round(pos * 1000) / 10}%`;
    })
    .filter((s): s is string => s != null)
    .join(", ");
}

/**
 * Approximate a Figma gradient paint as a CSS gradient string. LINEAR recovers
 * the angle from the inverted gradientTransform mapped onto the element box;
 * RADIAL/DIAMOND -> radial-gradient, ANGULAR -> conic-gradient (centered approx).
 * width/height refine the linear angle for non-square boxes (default square).
 * Note: radial/angular/diamond are approximations of Figma's exact geometry.
 */
export function cssGradient(
  paint: unknown,
  width = 1,
  height = 1,
): string | undefined {
  if (!paint || typeof paint !== "object") {
    return undefined;
  }
  const o = paint as Record<string, unknown>;
  const stopStr = gradientStopsCss(o.gradientStops);
  if (!stopStr) {
    return undefined;
  }
  if (o.type === "GRADIENT_LINEAR") {
    let angle = 180;
    const inv = Array.isArray(o.gradientTransform)
      ? invert2x3(o.gradientTransform as Mat)
      : null;
    if (inv) {
      const start = applyMat(inv, 0, 0.5);
      const end = applyMat(inv, 1, 0.5);
      const dx = (end.x - start.x) * (width || 1);
      const dy = (end.y - start.y) * (height || 1);
      let a = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      a = ((a % 360) + 360) % 360;
      angle = Math.round(a * 10) / 10;
    }
    return `linear-gradient(${angle}deg, ${stopStr})`;
  }
  if (o.type === "GRADIENT_RADIAL" || o.type === "GRADIENT_DIAMOND") {
    return `radial-gradient(${stopStr})`;
  }
  if (o.type === "GRADIENT_ANGULAR") {
    return `conic-gradient(${stopStr})`;
  }
  return undefined;
}

// --- per-node CSS block ------------------------------------------------------

function pickTopPaint(paints: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(paints)) {
    return undefined;
  }
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (
      p &&
      typeof p === "object" &&
      (p as Record<string, unknown>).visible !== false
    ) {
      return p as Record<string, unknown>;
    }
  }
  return undefined;
}

function paintToBackground(p: Record<string, unknown>): string | undefined {
  if (p.type === "SOLID" && typeof p.cssColor === "string") {
    return p.cssColor;
  }
  if (typeof p.cssGradient === "string") {
    return p.cssGradient;
  }
  return undefined;
}

/**
 * Compose a ready-to-apply CSS block for a serialized node from its already-derived
 * pieces (cssColor/cssGradient/cssBoxShadow + corner radii + opacity). When
 * `opts.absolute`, adds position/left/top/width/height from the node's `rel` box.
 */
export function buildNodeCss(
  base: Record<string, unknown>,
  opts: { absolute?: boolean } = {},
): Record<string, unknown> | undefined {
  const css: Record<string, unknown> = {};

  const fill = pickTopPaint(base.fills);
  if (fill) {
    const bg = paintToBackground(fill);
    if (bg) {
      css.background = bg;
    }
  }

  const strokeWeight = num(base.strokeWeight);
  const stroke = pickTopPaint(base.strokes);
  if (stroke && strokeWeight != null && strokeWeight > 0) {
    const c = stroke.cssColor;
    if (typeof c === "string") {
      css.border = `${strokeWeight}px solid ${c}`;
    }
  }

  const radius = num(base.cornerRadius);
  if (radius != null && radius > 0) {
    css.borderRadius = `${radius}px`;
  } else if (Array.isArray(base.rectangleCornerRadii)) {
    const vals = (base.rectangleCornerRadii as unknown[]).map((x) => num(x) ?? 0);
    if (vals.length === 4 && vals.some((v) => v > 0)) {
      css.borderRadius = `${vals[0]}px ${vals[1]}px ${vals[2]}px ${vals[3]}px`;
    }
  }

  const shadow = cssBoxShadow(base.effects);
  if (shadow) {
    css.boxShadow = shadow;
  }
  const { filter, backdropFilter } = cssBlurFilters(base.effects);
  if (filter) {
    css.filter = filter;
  }
  if (backdropFilter) {
    css.backdropFilter = backdropFilter;
  }

  const opacity = num(base.opacity);
  if (opacity != null && opacity < 1) {
    css.opacity = opacity;
  }

  if (opts.absolute && base.rel && typeof base.rel === "object") {
    const rel = base.rel as Record<string, unknown>;
    const x = num(rel.x);
    const y = num(rel.y);
    if (x != null && y != null) {
      css.position = "absolute";
      css.left = `${x}px`;
      css.top = `${y}px`;
      const w = num(rel.width);
      const h = num(rel.height);
      if (w != null) {
        css.width = `${w}px`;
      }
      if (h != null) {
        css.height = `${h}px`;
      }
    }
  }

  return Object.keys(css).length ? css : undefined;
}

export type RawVar = {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
};
export type RawCol = { id: string; name: string; defaultModeId: string };
export type VarSnapshot = { collections: unknown[]; variables: unknown[] };

export function isAlias(
  v: unknown,
): v is { type: "VARIABLE_ALIAS"; id: string } {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (v as { id?: unknown }).id === "string"
  );
}

/** Resolve a variable to its default-mode value, following alias chains. */
export function resolveVar(
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
export function collectVarIds(value: unknown, into: Set<string>): void {
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
export function resolveTokens(
  roots: unknown[],
  snapshot: VarSnapshot,
): VarSnapshot {
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
      for (const [field, ref] of Object.entries(
        bv as Record<string, unknown>,
      )) {
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

/** Gather unique imageHash values from IMAGE paints in the serialized tree. */
export function collectImageHashes(roots: unknown[]): string[] {
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
