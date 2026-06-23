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
