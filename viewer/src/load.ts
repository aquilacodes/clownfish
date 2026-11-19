import type { ServiceMap } from '../../src/core/model.ts';
import { fromXmlTree, fromDom } from '../../src/core/xmlmodel.ts';

export function parseMapText(text: string): ServiceMap {
  const t = text.trimStart();
  if (t.startsWith('<')) {
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('The XML file could not be parsed: ' + (err.textContent ?? '').slice(0, 160));
    return fromXmlTree(fromDom(doc.documentElement));
  }
  const m = JSON.parse(t);
  if (!m || !Array.isArray(m.nodes) || !Array.isArray(m.edges)) throw new Error('This JSON file is not a clownfish service map (missing nodes/edges).');
  return m as ServiceMap;
}

export async function apiAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/api/health');
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

export interface ScanSummary {
  id: string;
  path: string;
  state: 'running' | 'done' | 'error';
  progress?: { phase: string; done?: number; total?: number; message?: string };
  error?: string;
  stats?: ServiceMap['stats'];
  finishedAt?: string;
}

export async function listScans(): Promise<ScanSummary[]> {
  const r = await fetch('/api/scans');
  return r.ok ? r.json() : [];
}

export async function fetchScanMap(id: string): Promise<ServiceMap> {
  const r = await fetch(`/api/scans/${encodeURIComponent(id)}/map`);
  if (!r.ok) throw new Error(`Scan ${id} has no map yet (${r.status}).`);
  return r.json();
}

export async function startScan(path: string): Promise<ScanSummary> {
  const r = await fetch('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `Scan failed to start (${r.status}).`);
  return body;
}

export async function pollScan(id: string, onTick: (s: ScanSummary) => void): Promise<ScanSummary> {
  for (;;) {
    const r = await fetch(`/api/scans/${encodeURIComponent(id)}`);
    const s: ScanSummary = await r.json();
    onTick(s);
    if (s.state !== 'running') return s;
    await new Promise((res) => setTimeout(res, 400));
  }
}

export async function fetchSource(file: string, line: number, context = 6): Promise<{ from: number; lines: string[] } | undefined> {
  try {
    const r = await fetch(`/api/source?file=${encodeURIComponent(file)}&line=${line}&context=${context}`);
    return r.ok ? r.json() : undefined;
  } catch {
    return undefined;
  }
}
