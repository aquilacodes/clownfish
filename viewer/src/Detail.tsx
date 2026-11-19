import { useEffect, useState } from 'react';
import type { MapNode, MapEdge, Shape, Evidence, ServiceMap } from '../../src/core/model.ts';
import { typeLabel } from './graph';
import { fetchSource } from './load';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | undefined;

interface Props {
  map: ServiceMap;
  byId: Map<string, MapNode>;
  selection: Selection;
  api: boolean;
  onSelect: (s: Selection) => void;
  onClose: () => void;
}

const HIDDEN_META = new Set(['health', 'style', 'table', 'method', 'path', 'sources', 'detailTypes']);

export function Detail({ map, byId, selection, api, onSelect, onClose }: Props) {
  if (!selection) return null;
  if (selection.kind === 'node') {
    const n = byId.get(selection.id);
    if (!n) return null;
    const inbound = map.edges.filter((e) => e.to === n.id);
    const outbound = map.edges.filter((e) => e.from === n.id);
    const meta = Object.entries(n.meta ?? {}).filter(([k, v]) => !HIDDEN_META.has(k) && v !== undefined && !(Array.isArray(v) && !v.length));
    return (
      <aside className="drawer" aria-label="Details">
        <header className="drawer-head">
          <div>
            <h2 className="mono">{n.label}</h2>
            <p className="sub">{describeNode(n)}</p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close details">
            Close
          </button>
        </header>
        {n.meta?.unmatched ? <p className="note">No route in {n.service} matches this call. The path was taken from the caller; check the target's routes or prefixes.</p> : null}
        {n.request ? (
          <Section title="Request body">
            <ShapeTree shape={n.request} />
          </Section>
        ) : null}
        {n.responses?.length ? (
          <Section title="Responses">
            {n.responses.map((r, i) => (
              <div key={i} className="response">
                <div className={`status s${String(r.status ?? 200)[0]}`}>{r.status ?? 'returns'}</div>
                <ShapeTree shape={r.shape} />
              </div>
            ))}
          </Section>
        ) : null}
        {meta.length ? (
          <Section title="Details">
            <dl className="kv">
              {meta.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="mono">{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}
        <Section title={`Called by (${inbound.length})`}>
          <EdgeList edges={inbound} byId={byId} side="from" onSelect={onSelect} />
        </Section>
        <Section title={`Calls (${outbound.length})`}>
          <EdgeList edges={outbound} byId={byId} side="to" onSelect={onSelect} />
        </Section>
        {n.evidence?.length ? (
          <Section title="Defined at">
            <EvidenceList list={n.evidence} root={map.root} api={api} />
          </Section>
        ) : null}
      </aside>
    );
  }
  const e = map.edges.find((x) => x.id === selection.id);
  if (!e) return null;
  const from = byId.get(e.from);
  const to = byId.get(e.to);
  return (
    <aside className="drawer" aria-label="Details">
      <header className="drawer-head">
        <div>
          <h2 className="mono">{[e.method, e.path].filter(Boolean).join(' ') || e.operations?.join(', ') || e.protocol}</h2>
          <p className="sub">{e.protocol} call</p>
        </div>
        <button className="ghost" onClick={onClose} aria-label="Close details">
          Close
        </button>
      </header>
      <div className="hop">
        <button className="link" onClick={() => onSelect({ kind: 'node', id: e.from })}>
          {from?.label ?? e.from}
        </button>
        <span className="hop-arrow" aria-hidden>
          ⟶
        </span>
        <button className="link" onClick={() => onSelect({ kind: 'node', id: e.to })}>
          {to?.label ?? e.to}
        </button>
      </div>
      <Section title="Confidence">
        <div className="meter" role="meter" aria-valuenow={Math.round(e.confidence * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${e.confidence * 100}%` }} />
        </div>
        <p className="sub">{confidenceText(e)}</p>
      </Section>
      {e.operations?.length ? (
        <Section title="Operations">
          <div className="chips">{e.operations.map((o) => <span key={o} className="chip mono">{o}</span>)}</div>
        </Section>
      ) : null}
      {e.request ? (
        <Section title={e.protocol === 'http' || e.protocol === 'ws' ? 'Request body sent' : 'Payload'}>
          <ShapeTree shape={e.request} />
        </Section>
      ) : null}
      {e.response ? (
        <Section title="Response received">
          <ShapeTree shape={e.response} />
        </Section>
      ) : null}
      {Array.isArray(e.meta?.sql) ? (
        <Section title="Statements">
          {(e.meta!.sql as string[]).map((q, i) => (
            <pre key={i} className="code">{q}</pre>
          ))}
        </Section>
      ) : null}
      {e.meta?.url ? (
        <Section title="URL as written">
          <pre className="code">{String(e.meta.url)}</pre>
        </Section>
      ) : null}
      <Section title={`Found in code (${e.evidence.length})`}>
        {e.evidence.length ? <EvidenceList list={e.evidence} root={map.root} api={api} /> : <p className="sub">Implied: nothing in the scanned code calls this endpoint, so it is shown as reachable from outside.</p>}
      </Section>
    </aside>
  );
}

function describeNode(n: MapNode): string {
  const parts: string[] = [];
  if (n.kind === 'endpoint') parts.push(n.type === 'http' ? 'HTTP endpoint' : n.type ?? 'endpoint');
  else if (n.kind === 'sink') parts.push(`${n.type} store`);
  else parts.push(n.kind);
  if (n.service) parts.push(`in ${n.service}`);
  return parts.join(' ');
}

function confidenceText(e: MapEdge): string {
  if (e.meta?.implicit) return 'Assumed caller.';
  if (e.confidence >= 0.9) return 'Target resolved from configuration and matched to a declared route or resource.';
  if (e.confidence >= 0.75) return 'Target resolved; route matched with parameters.';
  if (e.confidence >= 0.55) return 'Matched by path or naming only. Worth a manual check.';
  return 'Weak match. Several candidates or an unresolved host.';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="drawer-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function ShapeTree({ shape, depth = 0 }: { shape: Shape; depth?: number }) {
  const base = shape.type === 'array' && shape.items ? shape.items : shape;
  const fields = Object.entries(base.fields ?? {});
  if (!fields.length) return <div className="shape-leaf mono">{typeLabel(shape)}</div>;
  return (
    <ul className={`shape ${depth ? 'nested' : ''}`}>
      {shape.type === 'array' ? <li className="shape-note">array of</li> : null}
      {fields.map(([k, f]) => {
        const inner = f.type === 'array' && f.items ? f.items : f;
        const hasKids = !!inner.fields && Object.keys(inner.fields).length > 0 && depth < 5;
        return (
          <li key={k}>
            <span className="mono fname">{k}</span>
            {f.optional ? <span className="opt">optional</span> : null}
            <span className="ftype mono">{typeLabel(f)}</span>
            {hasKids ? <ShapeTree shape={f} depth={depth + 1} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function EdgeList({ edges, byId, side, onSelect }: { edges: MapEdge[]; byId: Map<string, MapNode>; side: 'from' | 'to'; onSelect: (s: Selection) => void }) {
  if (!edges.length) return <p className="sub">None in the scanned code.</p>;
  return (
    <ul className="edge-list">
      {edges.map((e) => {
        const other = byId.get(e[side]);
        return (
          <li key={e.id}>
            <button className="link" onClick={() => onSelect({ kind: 'edge', id: e.id })}>
              <span className="mono">{other?.label ?? e[side]}</span>
            </button>
            <span className="sub">{other?.service && other.kind === 'endpoint' ? other.service : e.protocol}</span>
          </li>
        );
      })}
    </ul>
  );
}

function EvidenceList({ list, root, api }: { list: Evidence[]; root: string; api: boolean }) {
  return (
    <ul className="evidence">
      {list.slice(0, 12).map((ev, i) => (
        <EvidenceItem key={i} ev={ev} root={root} api={api} />
      ))}
    </ul>
  );
}

function EvidenceItem({ ev, root, api }: { ev: Evidence; root: string; api: boolean }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<{ from: number; lines: string[] }>();
  useEffect(() => {
    if (open && api && !src) fetchSource(ev.file, ev.line).then(setSrc);
  }, [open, api, src, ev]);
  const rel = ev.file.startsWith(root) ? ev.file.slice(root.length + 1) : ev.file;
  return (
    <li>
      <div className="ev-row">
        <button className="link mono" onClick={() => setOpen(!open)} aria-expanded={open}>
          {rel}:{ev.line}
        </button>
        <a className="ev-open" href={`vscode://file/${ev.file}:${ev.line}:${ev.col}`} title="Open in VS Code">
          Open in editor
        </a>
      </div>
      {open ? (
        src ? (
          <pre className="code">
            {src.lines.map((l, i) => (
              <div key={i} className={src.from + i === ev.line ? 'hot' : ''}>
                <span className="ln">{src.from + i}</span>
                {l}
              </div>
            ))}
          </pre>
        ) : ev.snippet ? (
          <pre className="code">
            <div className="hot">
              <span className="ln">{ev.line}</span>
              {ev.snippet}
            </div>
          </pre>
        ) : null
      ) : null}
    </li>
  );
}
