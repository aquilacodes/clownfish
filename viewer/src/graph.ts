// Turns a ServiceMap into a filtered, laid-out React Flow graph (ELK layered, left → right).
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';
import type { ServiceMap, MapNode, MapEdge, Shape } from '../../src/core/model.ts';

export type Column = 'callers' | 'endpoints' | 'messaging' | 'stores';

export interface ViewOptions {
  hiddenProtocols: string[];
  showHealth: boolean;
  showImplicit: boolean;
  minConfidence: number;
  collapsed: string[]; // service ids
}

export const DEFAULT_VIEW: ViewOptions = { hiddenProtocols: [], showHealth: false, showImplicit: true, minConfidence: 0, collapsed: [] };

export interface CfNodeData extends Record<string, unknown> {
  node: MapNode;
  column: Column;
  /** aggregated operations of inbound edges (stores) */
  ops?: string[];
  fields?: { name: string; type: string }[];
  resFields?: { name: string; type: string }[];
  collapsedCount?: number;
}

export interface GroupData extends Record<string, unknown> {
  service: string;
  kind: string;
  frameworks: string[];
  ports: number[];
  count: number;
}

export interface CfEdgeData extends Record<string, unknown> {
  edge: MapEdge;
  family: 'http' | 'ws' | 'messaging' | 'store' | 'invoke' | 'implicit';
}

export interface Prepared {
  nodes: Node[];
  edges: Edge[];
  columns: { columns: Column[]; x0: number; x1: number }[];
  byId: Map<string, MapNode>;
  visibleEdges: MapEdge[];
}

export const columnOf = (n: MapNode): Column =>
  n.kind === 'entry' ? 'callers' : n.kind === 'endpoint' || n.kind === 'function' ? 'endpoints' : n.kind === 'queue' || n.kind === 'topic' || n.kind === 'bus' ? 'messaging' : 'stores';

export const familyOf = (e: MapEdge): CfEdgeData['family'] =>
  e.meta?.implicit ? 'implicit' : e.protocol === 'http' ? 'http' : e.protocol === 'ws' ? 'ws' : ['sqs', 'sns', 'eventbridge', 'subscription'].includes(e.protocol) ? 'messaging' : e.protocol === 'invoke' || e.protocol === 'lambda' ? 'invoke' : 'store';

export function shapeFields(s: Shape | undefined, max = 8): { name: string; type: string }[] {
  if (!s) return [];
  const base = s.type === 'array' && s.items ? s.items : s;
  return Object.entries(base.fields ?? {})
    .slice(0, max)
    .map(([name, f]) => ({ name: name + (f.optional ? '?' : ''), type: typeLabel(f) }));
}

export function typeLabel(s: Shape): string {
  if (s.type === 'array') return `${s.items ? typeLabel(s.items) : 'unknown'}[]`;
  if (s.typeName) return s.typeName;
  if (s.type === 'object') return s.fields && Object.keys(s.fields).length ? '{…}' : 'object';
  return s.type === 'unknown' ? '' : s.type;
}

const elk = new ELK();

const textWidth = (s: string, mono = false) => s.length * (mono ? 7.6 : 7.1);

export async function prepare(map: ServiceMap, view: ViewOptions): Promise<Prepared> {
  const hidden = new Set(view.hiddenProtocols);
  const collapsed = new Set(view.collapsed);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));

  // --- filter
  const healthHidden = (n: MapNode | undefined) => !view.showHealth && !!n?.meta?.health;
  let edges = map.edges.filter((e) => !hidden.has(familyOf(e)) && e.confidence >= view.minConfidence && (view.showImplicit || !e.meta?.implicit) && !healthHidden(byId.get(e.from)) && !healthHidden(byId.get(e.to)));

  // --- collapse services: endpoints of collapsed services become one node
  const alias = (id: string) => {
    const n = byId.get(id);
    if (n && n.service && collapsed.has(n.service) && (n.kind === 'endpoint' || n.kind === 'function')) return `collapsed:${n.service}`;
    return id;
  };
  const merged = new Map<string, MapEdge>();
  for (const e of edges) {
    const from = alias(e.from);
    const to = alias(e.to);
    if (from === to) continue;
    const k = `${from}|${to}|${e.protocol}`;
    const ex = merged.get(k);
    if (!ex) merged.set(k, from === e.from && to === e.to ? e : { ...e, id: k, from, to, method: from !== e.from || to !== e.to ? undefined : e.method, path: undefined });
    else merged.set(k, { ...ex, operations: [...new Set([...(ex.operations ?? []), ...(e.operations ?? [])])], confidence: Math.max(ex.confidence, e.confidence), evidence: [...ex.evidence, ...e.evidence].slice(0, 30) });
  }
  edges = [...merged.values()];

  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes: MapNode[] = [];
  for (const n of map.nodes) {
    if (healthHidden(n)) continue;
    const a = alias(n.id);
    if (a !== n.id) {
      if (!byId.has(a)) {
        const svc = map.services.find((s) => s.id === n.service);
        byId.set(a, { id: a, kind: 'endpoint', label: `${svc?.name ?? n.service}`, service: n.service, type: 'collapsed', meta: {} });
      }
      continue;
    }
    // keep endpoints even if isolated (they document the API); drop isolated others
    if (!used.has(n.id) && n.kind !== 'endpoint') continue;
    nodes.push(n);
  }
  for (const c of collapsed) if (used.has(`collapsed:${c}`)) nodes.push(byId.get(`collapsed:${c}`)!);

  const opsByTarget = new Map<string, Set<string>>();
  for (const e of edges) for (const o of e.operations ?? []) {
    let s = opsByTarget.get(e.to);
    if (!s) opsByTarget.set(e.to, (s = new Set()));
    s.add(o);
  }

  // --- sizes
  const sizeOf = (n: MapNode) => {
    const col = columnOf(n);
    if (n.kind === 'endpoint') {
      const req = shapeFields(n.request);
      const res = shapeFields(n.responses?.find((r) => !r.status || r.status < 300)?.shape ?? n.responses?.[0]?.shape);
      const w = Math.min(380, Math.max(220, textWidth(n.label, true) + 70, ...req.concat(res).map((f) => textWidth(f.name + f.type, true) + 60)));
      const rows = Math.min(req.length, 8) + Math.min(res.length, 8) + (req.length ? 1 : 0) + (res.length ? 1 : 0);
      return { width: w, height: 58 + rows * 17 };
    }
    if (col === 'stores') {
      const cols = (n.meta?.columns as string[] | undefined)?.length ?? 0;
      return { width: Math.min(340, Math.max(200, textWidth(n.label, true) + 60)), height: 62 + (cols ? 18 : 0) };
    }
    return { width: Math.min(320, Math.max(180, textWidth(n.label) + 70)), height: 56 };
  };

  // --- ELK graph
  const groups = new Map<string, MapNode[]>();
  const top: MapNode[] = [];
  for (const n of nodes) {
    if ((n.kind === 'endpoint' || n.kind === 'function') && n.service) {
      let g = groups.get(n.service);
      if (!g) groups.set(n.service, (g = []));
      g.push(n);
    } else top.push(n);
  }
  const layerOf = (n: MapNode) => (n.kind === 'entry' ? 'FIRST_SEPARATE' : columnOf(n) === 'stores' ? 'LAST_SEPARATE' : 'NONE');
  const elkNode = (n: MapNode) => ({ id: n.id, ...sizeOf(n), layoutOptions: { 'elk.layered.layering.layerConstraint': layerOf(n) } });
  const graph: any = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '22',
      'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=60,left=40,bottom=40,right=40]',
    },
    children: [
      ...top.map(elkNode),
      ...[...groups].map(([svc, members]) => ({
        id: `group:${svc}`,
        layoutOptions: { 'elk.padding': '[top=44,left=16,bottom=16,right=16]', 'elk.spacing.nodeNode': '14', 'elk.direction': 'RIGHT' },
        children: members.map((m) => ({ id: m.id, ...sizeOf(m) })),
      })),
    ],
    edges: edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const laid = await elk.layout(graph);

  // --- to React Flow
  const rfNodes: Node[] = [];
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const c of laid.children ?? []) {
    if (c.id.startsWith('group:')) {
      const svcId = c.id.slice(6);
      const svc = map.services.find((s) => s.id === svcId);
      rfNodes.push({
        id: c.id,
        type: 'group-svc',
        position: { x: c.x ?? 0, y: c.y ?? 0 },
        style: { width: c.width, height: c.height },
        data: { service: svc?.name ?? svcId, kind: svc?.kind ?? 'service', frameworks: svc?.frameworks ?? [], ports: svc?.ports ?? [], count: c.children?.length ?? 0 } satisfies GroupData,
        selectable: false,
        draggable: true,
        zIndex: 0,
      });
      pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
      for (const k of c.children ?? []) {
        const n = byId.get(k.id)!;
        rfNodes.push(cfNode(n, k, c.id, opsByTarget));
        pos.set(k.id, { x: (c.x ?? 0) + (k.x ?? 0), y: (c.y ?? 0) + (k.y ?? 0), w: k.width ?? 0, h: k.height ?? 0 });
      }
    } else {
      const n = byId.get(c.id)!;
      rfNodes.push(cfNode(n, c, undefined, opsByTarget));
      pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
    }
  }

  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: 'cf',
    data: { edge: e, family: familyOf(e) } satisfies CfEdgeData,
    zIndex: 1,
  }));

  // --- column bands (x extents per column)
  const ext = new Map<Column, { x0: number; x1: number }>();
  for (const n of nodes) {
    const p = pos.get(n.service && (n.kind === 'endpoint' || n.kind === 'function') ? `group:${n.service}` : n.id) ?? pos.get(n.id);
    if (!p) continue;
    const c = columnOf(n);
    const cur = ext.get(c);
    ext.set(c, cur ? { x0: Math.min(cur.x0, p.x), x1: Math.max(cur.x1, p.x + p.w) } : { x0: p.x, x1: p.x + p.w });
  }
  // merge bands that overlap horizontally (messaging often sits between service frames)
  const columns: Prepared['columns'] = [];
  for (const c of (['callers', 'endpoints', 'messaging', 'stores'] as Column[]).filter((c) => ext.has(c))) {
    const e = ext.get(c)!;
    const prev = columns.at(-1);
    if (prev && e.x0 < prev.x1 - 4) {
      prev.columns.push(c);
      prev.x1 = Math.max(prev.x1, e.x1);
      prev.x0 = Math.min(prev.x0, e.x0);
    } else columns.push({ columns: [c], ...e });
  }

  return { nodes: rfNodes, edges: rfEdges, columns, byId, visibleEdges: edges };
}

function cfNode(n: MapNode, k: any, parentId: string | undefined, opsByTarget: Map<string, Set<string>>): Node {
  const ok = n.responses?.find((r) => !r.status || r.status < 300) ?? n.responses?.[0];
  return {
    id: n.id,
    type: 'cf',
    position: { x: k.x ?? 0, y: k.y ?? 0 },
    style: { width: k.width, height: k.height },
    parentId,
    extent: parentId ? 'parent' : undefined,
    data: {
      node: n,
      column: columnOf(n),
      ops: [...(opsByTarget.get(n.id) ?? [])],
      fields: shapeFields(n.request),
      resFields: shapeFields(ok?.shape),
    } satisfies CfNodeData,
    zIndex: 2,
  };
}

/** Upstream + downstream closure of a node over the visible edges. */
export function trace(edges: MapEdge[], start: string, dir: 'both' | 'up' | 'down' = 'both'): { nodes: Set<string>; edges: Set<string> } {
  const out = new Map<string, MapEdge[]>();
  const inn = new Map<string, MapEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }
  const nodes = new Set([start]);
  const es = new Set<string>();
  const walk = (id: string, dir: 'down' | 'up', seen: Set<string>) => {
    for (const e of (dir === 'down' ? out : inn).get(id) ?? []) {
      es.add(e.id);
      const nx = dir === 'down' ? e.to : e.from;
      nodes.add(nx);
      if (!seen.has(nx)) {
        seen.add(nx);
        walk(nx, dir, seen);
      }
    }
  };
  if (dir !== 'up') walk(start, 'down', new Set([start]));
  if (dir !== 'down') walk(start, 'up', new Set([start]));
  return { nodes, edges: es };
}
