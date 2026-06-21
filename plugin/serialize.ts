/// <reference types="@figma/plugin-typings" />

export type ExportPhase = 1 | 2 | 3;

export type ExportScope = "selection" | "page";

const PLUGIN_VERSION = "0.1.0";
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

function bbox(
  node: SceneNode,
): { x: number; y: number; width: number; height: number } | null {
  const b = node.absoluteBoundingBox;
  if (b) {
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  if ("width" in node && "height" in node) {
    const g = node as LayoutMixin;
    return {
      x: "x" in node ? (node as LayoutMixin).x : 0,
      y: "y" in node ? (node as LayoutMixin).y : 0,
      width: g.width,
      height: g.height,
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
    o.gradientStops = paint.gradientStops?.length ?? 0;
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
  return o;
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
  }

  const le = layoutExtras(node);
  if (le) {
    base.layout = le;
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
    payload.variables = await variableSnapshot();
  }

  if (opts.phase >= 3 && Object.keys(rasters).length > 0) {
    payload.rasters = rasters;
  }

  return payload;
}
