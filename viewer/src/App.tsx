import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, ViewportPortal, useReactFlow, getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import type { ServiceMap } from '../../src/core/model.ts';
import { prepare, trace, DEFAULT_VIEW, type ViewOptions, type Prepared, type CfNodeData } from './graph';
import { nodeTypes, edgeTypes, HighlightCtx, type Highlight } from './flow';
import { Detail, type Selection } from './Detail';
import { parseMapText, apiAvailable, listScans, fetchScanMap, startScan, pollScan, type ScanSummary } from './load';

const FAMILIES: { id: string; label: string }[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'ws', label: 'WebSocket' },
  { id: 'messaging', label: 'Queues & topics' },
  { id: 'invoke', label: 'Lambda' },
  { id: 'store', label: 'Data stores' },
];
const COLUMN_TEXT = { callers: 'Callers', endpoints: 'Endpoints', messaging: 'Messaging', stores: 'Data stores' } as const;

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? { ...d, ...JSON.parse(v) } : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

export function App() {
  return (
    <ReactFlowProvider>
      <Viewer />
    </ReactFlowProvider>
  );
}

function Viewer() {
  const [map, setMap] = useState<ServiceMap>();
  const [source, setSource] = useState<string>('');
  const [api, setApi] = useState(false);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<ViewOptions>(() => store.get('cf.view', DEFAULT_VIEW));
  const [prep, setPrep] = useState<Prepared>();
  const [layingOut, setLayingOut] = useState(false);
  const [selection, setSelection] = useState<Selection>();
  const [query, setQuery] = useState('');
  const [scanPath, setScanPath] = useState('');
  const [scanState, setScanState] = useState<ScanSummary>();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>(() => store.get('cf.theme', { t: 'auto' as const }).t);
  const [dragging, setDragging] = useState(false);
  const rf = useReactFlow();
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => store.set('cf.view', view), [view]);
  useEffect(() => {
    store.set('cf.theme', { t: theme });
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ---------- initial load: ?map=url | ?scan=id | latest scan from API
  useEffect(() => {
    (async () => {
      const hasApi = await apiAvailable();
      setApi(hasApi);
      const qs = new URLSearchParams(location.search);
      try {
        if (qs.get('map')) {
          const r = await fetch(qs.get('map')!);
          load(parseMapText(await r.text()), qs.get('map')!);
        } else if (hasApi) {
          const scans = await listScans();
          const want = qs.get('scan') ? scans.find((s) => s.id === qs.get('scan')) : scans.filter((s) => s.state === 'done').at(-1);
          if (want?.state === 'done') load(await fetchScanMap(want.id), want.path);
        }
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    })();
  }, []);

  const load = (m: ServiceMap, src: string) => {
    setMap(m);
    setSource(src);
    setSelection(undefined);
    setError(undefined);
  };

  // ---------- layout whenever map/filters change
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    setLayingOut(true);
    prepare(map, view)
      .then((p) => {
        if (cancelled) return;
        setPrep(p);
        requestAnimationFrame(() => rf.fitView({ padding: 0.08, duration: 0 }));
      })
      .catch((e) => setError(`Layout failed: ${e?.message ?? e}`))
      .finally(() => !cancelled && setLayingOut(false));
    return () => {
      cancelled = true;
    };
  }, [map, view]);

  // ---------- highlight / trace
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !prep) return new Set<string>();
    return new Set(prep.nodes.filter((n) => n.type === 'cf' && matchNode(n as Node<CfNodeData>, q)).map((n) => n.id));
  }, [query, prep]);

  const highlight: Highlight = useMemo(() => {
    const base = { match: matches, onToggleService: (svcName: string) => toggleService(svcName) };
    if (!prep || !selection) return { ...base, active: false, nodes: new Set(), edges: new Set() };
    if (selection.kind === 'node') {
      const t = trace(prep.visibleEdges, selection.id);
      return { ...base, active: true, nodes: t.nodes, edges: t.edges, selected: selection.id };
    }
    const e = prep.visibleEdges.find((x) => x.id === selection.id);
    if (!e) return { ...base, active: false, nodes: new Set(), edges: new Set() };
    const up = trace(prep.visibleEdges, e.from, 'up');
    const down = trace(prep.visibleEdges, e.to, 'down');
    const nodes = new Set<string>([...up.nodes, ...down.nodes]);
    const edges = new Set<string>([e.id, ...up.edges, ...down.edges]);
    return { ...base, active: true, nodes, edges, selected: undefined };
  }, [prep, selection, matches]);

  const toggleService = useCallback(
    (svcName: string) => {
      const svc = map?.services.find((s) => s.name === svcName || s.id === svcName);
      if (!svc) return;
      setView((v) => ({ ...v, collapsed: v.collapsed.includes(svc.id) ? v.collapsed.filter((x) => x !== svc.id) : [...v.collapsed, svc.id] }));
    },
    [map],
  );

  // ---------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === 'Escape') {
        setSelection(undefined);
        setFiltersOpen(false);
        if (typing) (e.target as HTMLElement).blur();
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === 'f' && !typing && !e.metaKey && !e.ctrlKey) rf.fitView({ padding: 0.08, duration: 300 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);

  const focusMatches = () => {
    if (!matches.size) return;
    const first = [...matches][0];
    setSelection({ kind: 'node', id: first });
    rf.fitView({ nodes: [...matches].map((id) => ({ id })), padding: 0.4, duration: 400, maxZoom: 1.4 });
  };

  // ---------- file / drop / scan
  const readFile = async (f: File) => {
    try {
      load(parseMapText(await f.text()), f.name);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };
  const runScan = async () => {
    if (!scanPath.trim()) return;
    try {
      setError(undefined);
      const s = await startScan(scanPath.trim());
      const done = await pollScan(s.id, setScanState);
      if (done.state === 'done') {
        load(await fetchScanMap(done.id), done.path);
        history.replaceState(null, '', `?scan=${done.id}`);
      } else setError(done.error ?? 'Scan failed.');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setScanState(undefined);
    }
  };

  const exportImage = async (kind: 'png' | 'svg') => {
    if (!prep) return;
    const el = document.querySelector('.react-flow__viewport') as HTMLElement;
    const bounds = getNodesBounds(prep.nodes);
    const width = Math.min(8000, bounds.width + 160);
    const height = Math.min(8000, bounds.height + 160);
    const vp = getViewportForBounds(bounds, width, height, 0.05, 2, 0.04);
    const bg = getComputedStyle(document.body).getPropertyValue('--canvas').trim();
    const opts = { backgroundColor: bg, width, height, style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` } };
    const url = kind === 'png' ? await toPng(el, { ...opts, pixelRatio: 2 }) : await toSvg(el, opts);
    download(url, `service-map.${kind}`);
  };
  const exportData = (fmt: 'json' | 'xml') => {
    if (!map) return;
    const id = new URLSearchParams(location.search).get('scan');
    if (api && id) {
      download(`/api/scans/${id}/map?format=${fmt}&download=1`, `service-map.${fmt}`);
      return;
    }
    if (fmt === 'json') download(URL.createObjectURL(new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' })), 'service-map.json');
    else import('../../src/core/xmlmodel.ts').then(({ toXml }) => download(URL.createObjectURL(new Blob([toXml(map)], { type: 'application/xml' })), 'service-map.xml'));
  };

  const stats = map?.stats;

  return (
    <div
      className={`app ${selection ? 'has-drawer' : ''} ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) readFile(f);
      }}
    >
      <header className="bar">
        <div className="brand">
          <Fish />
          <span className="brand-name">clownfish</span>
        </div>
        {map ? (
          <div className="where" title={map.root}>
            <span className="mono path">{shortPath(source || map.root)}</span>
            <span className="counts">
              {stats?.services} packages, {map.nodes.length} nodes, {map.edges.length} calls
              {map.warnings.length ? `, ${map.warnings.length} warnings` : ''}
            </span>
          </div>
        ) : (
          <div className="where" />
        )}
        <div className="search">
          <input
            ref={searchRef}
            type="search"
            placeholder="Find a service, route, table or queue  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && focusMatches()}
            aria-label="Search the map"
            disabled={!map}
          />
          {query ? <span className="search-count">{matches.size} found</span> : null}
        </div>
        <div className="actions">
          <button className="ghost" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen} disabled={!map}>
            Filters{activeFilterCount(view) ? ` (${activeFilterCount(view)})` : ''}
          </button>
          <details className="menu">
            <summary className="ghost">Export</summary>
            <div className="menu-pop">
              <button onClick={() => exportData('json')} disabled={!map}>Map as JSON</button>
              <button onClick={() => exportData('xml')} disabled={!map}>Map as XML</button>
              <button onClick={() => exportImage('png')} disabled={!prep}>Image as PNG</button>
              <button onClick={() => exportImage('svg')} disabled={!prep}>Image as SVG</button>
            </div>
          </details>
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Open map
          </button>
          <button className="ghost" onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')} title="Theme: auto, dark or light">
            {theme === 'auto' ? 'Auto theme' : theme === 'dark' ? 'Dark' : 'Light'}
          </button>
          <input ref={fileRef} type="file" accept=".json,.xml,application/json,application/xml" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
        </div>
      </header>

      {filtersOpen && map ? <Filters view={view} setView={setView} services={map.services} /> : null}
      {error ? (
        <div className="toast" role="alert">
          {error}
          <button className="ghost tiny" onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      ) : null}

      <main className="stage">
        {!map ? (
          <Empty api={api} scanPath={scanPath} setScanPath={setScanPath} runScan={runScan} scanState={scanState} onOpen={() => fileRef.current?.click()} />
        ) : (
          <HighlightCtx.Provider value={highlight}>
            <ReactFlow
              nodes={prep?.nodes ?? []}
              edges={prep?.edges ?? []}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              minZoom={0.02}
              maxZoom={8}
              onlyRenderVisibleElements
              nodesConnectable={false}
              elevateEdgesOnSelect={false}
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_, n) => n.type === 'cf' && setSelection({ kind: 'node', id: n.id })}
              onEdgeClick={(_, e) => setSelection({ kind: 'edge', id: e.id })}
              onPaneClick={() => setSelection(undefined)}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} className="bg" />
              {prep ? (
                <ViewportPortal>
                  {prep.columns.map((c) => (
                    <div key={c.columns.join('+')} className={`col-band col-${c.columns[0]}`} style={{ transform: `translate(${c.x0 - 12}px, 0px)`, width: c.x1 - c.x0 + 24 }}>
                      <span>{c.columns.map((k) => COLUMN_TEXT[k]).join(' and ')}</span>
                    </div>
                  ))}
                </ViewportPortal>
              ) : null}
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable position="bottom-right" nodeColor={miniColor} nodeStrokeWidth={0} maskColor="var(--mask)" />
            </ReactFlow>
            {layingOut ? <div className="busy">Arranging {map.nodes.length} nodes…</div> : null}
            <Legend />
          </HighlightCtx.Provider>
        )}
      </main>

      {map && prep ? <Detail map={map} byId={prep.byId} selection={selection} api={api} onSelect={setSelection} onClose={() => setSelection(undefined)} /> : null}
      {dragging ? <div className="dropzone">Drop a .json or .xml service map to open it</div> : null}
    </div>
  );
}

function matchNode(n: Node<CfNodeData>, q: string) {
  const m = n.data.node;
  return [m.label, m.service, m.type, m.meta?.table, m.meta?.key, m.meta?.queue].some((x) => typeof x === 'string' && x.toLowerCase().includes(q));
}

function miniColor(n: Node) {
  if (n.type === 'group-svc') return 'var(--group-fill)';
  const c = (n.data as CfNodeData).column;
  return `var(--c-${c})`;
}

function activeFilterCount(v: ViewOptions) {
  return v.hiddenProtocols.length + (v.showHealth ? 1 : 0) + (v.showImplicit ? 0 : 1) + (v.minConfidence > 0 ? 1 : 0) + v.collapsed.length;
}

function shortPath(p: string) {
  return p.replace(/^\/(Users|home)\/[^/]+/, '~');
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function Filters({ view, setView, services }: { view: ViewOptions; setView: (f: (v: ViewOptions) => ViewOptions) => void; services: ServiceMap['services'] }) {
  return (
    <div className="filters" role="dialog" aria-label="Filters">
      <fieldset>
        <legend>Show calls over</legend>
        {FAMILIES.map((f) => (
          <label key={f.id} className="check">
            <input
              type="checkbox"
              checked={!view.hiddenProtocols.includes(f.id)}
              onChange={(e) => setView((v) => ({ ...v, hiddenProtocols: e.target.checked ? v.hiddenProtocols.filter((x) => x !== f.id) : [...v.hiddenProtocols, f.id] }))}
            />
            <span className={`swatch f-${f.id}`} />
            {f.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Include</legend>
        <label className="check">
          <input type="checkbox" checked={view.showHealth} onChange={(e) => setView((v) => ({ ...v, showHealth: e.target.checked }))} />
          Health and readiness checks
        </label>
        <label className="check">
          <input type="checkbox" checked={view.showImplicit} onChange={(e) => setView((v) => ({ ...v, showImplicit: e.target.checked }))} />
          External clients for endpoints nothing calls
        </label>
        <label className="range">
          Minimum confidence <strong>{Math.round(view.minConfidence * 100)}%</strong>
          <input type="range" min={0} max={0.95} step={0.05} value={view.minConfidence} onChange={(e) => setView((v) => ({ ...v, minConfidence: Number(e.target.value) }))} />
        </label>
      </fieldset>
      <fieldset>
        <legend>Collapsed services</legend>
        {view.collapsed.length ? (
          view.collapsed.map((id) => (
            <label key={id} className="check">
              <input type="checkbox" checked onChange={() => setView((v) => ({ ...v, collapsed: v.collapsed.filter((x) => x !== id) }))} />
              {services.find((s) => s.id === id)?.name ?? id}
            </label>
          ))
        ) : (
          <p className="sub">Use Collapse on a service frame to fold its endpoints into one node.</p>
        )}
      </fieldset>
      <button className="ghost" onClick={() => setView(() => DEFAULT_VIEW)}>
        Reset filters
      </button>
    </div>
  );
}

function Empty({ api, scanPath, setScanPath, runScan, scanState, onOpen }: { api: boolean; scanPath: string; setScanPath: (s: string) => void; runScan: () => void; scanState?: ScanSummary; onOpen: () => void }) {
  return (
    <div className="empty">
      <Fish big />
      <h1>See how your services talk to each other.</h1>
      <p>Scan a folder of Node.js services to map every HTTP, WebSocket, queue and topic call, from the caller on the left to the table, key or bucket where it ends on the right.</p>
      {api ? (
        <form
          className="scan-form"
          onSubmit={(e) => {
            e.preventDefault();
            runScan();
          }}
        >
          <input className="mono" value={scanPath} onChange={(e) => setScanPath(e.target.value)} placeholder="~/code/my-platform" aria-label="Folder to scan" disabled={!!scanState} />
          <button type="submit" className="primary" disabled={!scanPath.trim() || !!scanState}>
            {scanState ? 'Scanning…' : 'Scan folder'}
          </button>
        </form>
      ) : (
        <pre className="code cli">clownfish scan ~/code -o map.json{'\n'}clownfish view map.json</pre>
      )}
      {scanState?.progress ? (
        <p className="sub">
          {scanState.progress.phase}
          {scanState.progress.total ? ` ${scanState.progress.done}/${scanState.progress.total} files` : ''}
        </p>
      ) : null}
      <p className="sub">
        Or <button className="link" onClick={onOpen}>open a map file</button> (.json or .xml), or drop one anywhere on this page.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      {FAMILIES.map((f) => (
        <span key={f.id}>
          <i className={`line f-${f.id}`} />
          {f.label}
        </span>
      ))}
      <span>
        <i className="line f-implicit" />
        Assumed
      </span>
    </div>
  );
}

function Fish({ big }: { big?: boolean }) {
  const s = big ? 64 : 22;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" aria-hidden className="fish">
      <path d="M3 16c5-7.5 13.5-9.5 21-4.2L28.5 8v16L24 20.2C16.5 25.5 8 23.5 3 16z" fill="var(--clown)" />
      <path d="M11.5 9.4c1.6 2.2 1.6 11 0 13.2M18 9.7c1.3 2.1 1.3 10.5 0 12.6" stroke="var(--clown-band)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <circle cx="7.6" cy="14.6" r="1.1" fill="var(--ink)" />
    </svg>
  );
}
