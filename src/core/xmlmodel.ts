// Lossless ServiceMap ⇄ XML mapping. Pure (no Node APIs) so the browser viewer can reuse the decoder.
import type { ServiceMap, Shape, MapNode, MapEdge, Evidence, ServiceInfo, Warning } from './model.ts';

export interface XEl {
  name: string;
  attrs: Record<string, string>;
  children: XEl[];
  text?: string;
}

// ------------------------------------------------------------------ encode
const esc = (s: unknown) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip chars illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function attrs(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
}

function shapeXml(s: Shape | undefined, tag = 'shape', ind = ''): string {
  if (!s) return '';
  const head = `${ind}<${tag}${attrs({ type: s.type, typeName: s.typeName, optional: s.optional ? 'true' : undefined, source: s.source })}`;
  const kids: string[] = [];
  for (const [k, v] of Object.entries(s.fields ?? {})) kids.push(`${ind}  <field name="${esc(k)}">\n${shapeXml(v, 'shape', ind + '    ')}\n${ind}  </field>`);
  if (s.items) kids.push(`${ind}  <items>\n${shapeXml(s.items, 'shape', ind + '    ')}\n${ind}  </items>`);
  return kids.length ? `${head}>\n${kids.join('\n')}\n${ind}</${tag}>` : `${head}/>`;
}

function metaXml(m: Record<string, unknown> | undefined, ind: string): string {
  if (!m) return '';
  const entries = Object.entries(m).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => {
    const type = typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'json';
    return `${ind}  <entry key="${esc(k)}" type="${type}">${esc(type === 'json' ? JSON.stringify(v) : v)}</entry>`;
  });
  return `${ind}<meta>\n${rows.join('\n')}\n${ind}</meta>`;
}

function evidenceXml(list: Evidence[] | undefined, ind: string): string {
  if (!list?.length) return '';
  return `${ind}<evidence>\n${list.map((e) => `${ind}  <at${attrs({ file: e.file, line: e.line, col: e.col })}>${esc(e.snippet ?? '')}</at>`).join('\n')}\n${ind}</evidence>`;
}

export function toXml(map: ServiceMap): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<serviceMap${attrs({ version: map.version, generatedAt: map.generatedAt, root: map.root })}>`);
  out.push(`  <stats${attrs(map.stats as any)}/>`);
  out.push('  <services>');
  for (const s of map.services) {
    out.push(`    <service${attrs({ id: s.id, name: s.name, root: s.root, kind: s.kind, language: s.language })}>`);
    for (const f of s.frameworks) out.push(`      <framework>${esc(f)}</framework>`);
    for (const a of s.aliases) out.push(`      <alias>${esc(a)}</alias>`);
    for (const p of s.ports) out.push(`      <port>${p}</port>`);
    out.push('    </service>');
  }
  out.push('  </services>');
  out.push('  <nodes>');
  for (const n of map.nodes) {
    out.push(`    <node${attrs({ id: n.id, kind: n.kind, label: n.label, service: n.service, type: n.type })}>`);
    const m = metaXml(n.meta, '      ');
    if (m) out.push(m);
    if (n.request) out.push(`      <request>\n${shapeXml(n.request, 'shape', '        ')}\n      </request>`);
    for (const r of n.responses ?? []) out.push(`      <response${attrs({ status: r.status })}>\n${shapeXml(r.shape, 'shape', '        ')}\n      </response>`);
    const e = evidenceXml(n.evidence, '      ');
    if (e) out.push(e);
    out.push('    </node>');
  }
  out.push('  </nodes>');
  out.push('  <edges>');
  for (const e of map.edges) {
    out.push(`    <edge${attrs({ id: e.id, from: e.from, to: e.to, protocol: e.protocol, method: e.method, path: e.path, confidence: e.confidence })}>`);
    for (const o of e.operations ?? []) out.push(`      <operation>${esc(o)}</operation>`);
    if (e.request) out.push(`      <request>\n${shapeXml(e.request, 'shape', '        ')}\n      </request>`);
    if (e.response) out.push(`      <response>\n${shapeXml(e.response, 'shape', '        ')}\n      </response>`);
    const m = metaXml(e.meta, '      ');
    if (m) out.push(m);
    const ev = evidenceXml(e.evidence, '      ');
    if (ev) out.push(ev);
    out.push('    </edge>');
  }
  out.push('  </edges>');
  out.push('  <flows>');
  for (const f of map.flows) out.push(`    <flow>${f.map((s) => `<step>${esc(s)}</step>`).join('')}</flow>`);
  out.push('  </flows>');
  out.push('  <warnings>');
  for (const w of map.warnings) out.push(`    <warning${attrs({ code: w.code, file: w.file, line: w.line })}>${esc(w.message)}</warning>`);
  out.push('  </warnings>');
  out.push('</serviceMap>');
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ decode
const kids = (e: XEl | undefined, name?: string) => (e?.children ?? []).filter((c) => !name || c.name === name);
const kid = (e: XEl | undefined, name: string) => kids(e, name)[0];
const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

function shapeFrom(e: XEl | undefined): Shape | undefined {
  if (!e) return undefined;
  const s: Shape = { type: (e.attrs.type as Shape['type']) ?? 'unknown' };
  if (e.attrs.typeName) s.typeName = e.attrs.typeName;
  if (e.attrs.optional === 'true') s.optional = true;
  if (e.attrs.source) s.source = e.attrs.source as Shape['source'];
  const fields = kids(e, 'field');
  if (fields.length) {
    s.fields = {};
    for (const f of fields) s.fields[f.attrs.name] = shapeFrom(kid(f, 'shape')) ?? { type: 'unknown' };
  } else if (s.type === 'object' && !s.typeName) s.fields = {};
  const items = kid(e, 'items');
  if (items) s.items = shapeFrom(kid(items, 'shape'));
  return s;
}

function metaFrom(e: XEl | undefined): Record<string, unknown> | undefined {
  if (!e) return undefined;
  const out: Record<string, unknown> = {};
  for (const en of kids(e, 'entry')) {
    const t = en.attrs.type;
    const raw = en.text ?? '';
    out[en.attrs.key] = t === 'number' ? Number(raw) : t === 'boolean' ? raw === 'true' : t === 'json' ? safeJson(raw) : raw;
  }
  return out;
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function evidenceFrom(e: XEl | undefined): Evidence[] | undefined {
  if (!e) return undefined;
  return kids(e, 'at').map((a) => ({ file: a.attrs.file, line: Number(a.attrs.line), col: Number(a.attrs.col), snippet: a.text || undefined }));
}

export function fromXmlTree(root: XEl): ServiceMap {
  if (root.name !== 'serviceMap') throw new Error(`Not a clownfish service map (root <${root.name}>)`);
  const st = kid(root, 'stats')?.attrs ?? {};
  const services: ServiceInfo[] = kids(kid(root, 'services'), 'service').map((s) => ({
    id: s.attrs.id,
    name: s.attrs.name,
    root: s.attrs.root,
    kind: s.attrs.kind as ServiceInfo['kind'],
    language: s.attrs.language as ServiceInfo['language'],
    frameworks: kids(s, 'framework').map((x) => x.text ?? ''),
    aliases: kids(s, 'alias').map((x) => x.text ?? ''),
    ports: kids(s, 'port').map((x) => Number(x.text)),
  }));
  const nodes: MapNode[] = kids(kid(root, 'nodes'), 'node').map((n) => {
    const node: MapNode = { id: n.attrs.id, kind: n.attrs.kind as MapNode['kind'], label: n.attrs.label };
    if (n.attrs.service) node.service = n.attrs.service;
    if (n.attrs.type) node.type = n.attrs.type;
    const meta = metaFrom(kid(n, 'meta'));
    if (meta) node.meta = meta;
    const req = shapeFrom(kid(kid(n, 'request'), 'shape'));
    if (req) node.request = req;
    const res = kids(n, 'response');
    if (res.length) node.responses = res.map((r) => ({ status: num(r.attrs.status), shape: shapeFrom(kid(r, 'shape')) ?? { type: 'unknown' } }));
    const ev = evidenceFrom(kid(n, 'evidence'));
    if (ev) node.evidence = ev;
    return node;
  });
  const edges: MapEdge[] = kids(kid(root, 'edges'), 'edge').map((e) => {
    const edge: MapEdge = { id: e.attrs.id, from: e.attrs.from, to: e.attrs.to, protocol: e.attrs.protocol as MapEdge['protocol'], confidence: Number(e.attrs.confidence), evidence: evidenceFrom(kid(e, 'evidence')) ?? [] };
    if (e.attrs.method) edge.method = e.attrs.method;
    if (e.attrs.path) edge.path = e.attrs.path;
    const ops = kids(e, 'operation').map((o) => o.text ?? '');
    if (ops.length) edge.operations = ops;
    const req = shapeFrom(kid(kid(e, 'request'), 'shape'));
    if (req) edge.request = req;
    const res = shapeFrom(kid(kid(e, 'response'), 'shape'));
    if (res) edge.response = res;
    const meta = metaFrom(kid(e, 'meta'));
    if (meta) edge.meta = meta;
    return edge;
  });
  const flows = kids(kid(root, 'flows'), 'flow').map((f) => kids(f, 'step').map((s) => s.text ?? ''));
  const warnings: Warning[] = kids(kid(root, 'warnings'), 'warning').map((w) => ({ code: w.attrs.code, message: w.text ?? '', file: w.attrs.file || undefined, line: num(w.attrs.line) }));
  return {
    version: root.attrs.version,
    generatedAt: root.attrs.generatedAt,
    root: root.attrs.root,
    stats: { services: Number(st.services), files: Number(st.files), nodes: Number(st.nodes), edges: Number(st.edges), flows: Number(st.flows), durationMs: Number(st.durationMs) },
    services,
    nodes,
    edges,
    flows,
    warnings,
  };
}

/** Browser helper: DOM Element → XEl. */
export function fromDom(el: Element): XEl {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const children = Array.from(el.children).map(fromDom);
  return { name: el.tagName, attrs, children, text: children.length ? undefined : el.textContent ?? '' };
}
