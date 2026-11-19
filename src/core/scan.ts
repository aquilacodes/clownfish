// Orchestrates a scan: discover → config → analyze files → program → roots → effects → linked graph.
import fs from 'node:fs';
import path from 'node:path';
import { discover, type DiscoverOptions, type DiscoveredService } from './discover.ts';
import { loadConfig, queueName, arnName } from './config.ts';
import { analyzeFile, type FileFacts, type RouteFacts, type Loc } from './analyze.ts';
import { Program, type Effect, type RootResult } from './program.ts';
import { parseUrl, matchScore, serviceForHost, applyProxy, normPath, segments } from './link.ts';
import { strings, shapeOf, mergeShapes, type Sym } from './sym.ts';
import { MAP_VERSION, type ServiceMap, type MapNode, type MapEdge, type Evidence, type Shape, type Warning, type ServiceInfo } from './model.ts';
import { analyzeParallel } from './pool.ts';

export interface ScanOptions extends DiscoverOptions {
  /** Add an "External clients" entry node feeding endpoints nobody calls. Default true. */
  externalClients?: boolean;
  /** Worker threads for parsing (0 = in-process). Default: min(8, cpus-1). */
  workers?: number;
  onProgress?: (p: { phase: string; done?: number; total?: number; message?: string }) => void;
}

type Style = RouteFacts['style'] | 'lambda';

interface Endpoint {
  node: MapNode;
  svc: string;
  method: string;
  path: string;
  style: Style;
  roots: string[];
}

const HEALTH = /^\/(healthz?|ready|readyz|livez?|liveness|readiness|ping|metrics|status|_health|health-check)$/i;

export async function scan(root: string, opts: ScanOptions = {}): Promise<ServiceMap> {
  const t0 = Date.now();
  const progress = opts.onProgress ?? (() => {});
  progress({ phase: 'discover' });
  const disc = await discover(root, opts);
  const services = disc.services;
  progress({ phase: 'config', message: `${services.length} packages, ${disc.configFiles.length} config files` });
  const cfg = loadConfig(disc.configFiles, services);
  const warnings: Warning[] = [...cfg.warnings];

  // ---------------------------------------------------------------- analyze
  const allFiles = services.flatMap((s) => s.files);
  progress({ phase: 'analyze', done: 0, total: allFiles.length });
  const facts: FileFacts[] = await analyzeParallel(allFiles, opts.workers, (done) => progress({ phase: 'analyze', done, total: allFiles.length }));
  for (const f of facts) if (f.error) warnings.push({ code: 'parse-error', message: f.error, file: f.file });

  progress({ phase: 'resolve' });
  const prog = new Program(services, cfg, facts);
  const svcById = new Map(services.map((s) => [s.id, s]));
  const ctxFor = (svc?: string) => prog.ctx(svc);

  // ---------------------------------------------------------------- ports from listen()
  for (const f of facts) {
    const svc = prog.serviceOf(f.file);
    if (!svc) continue;
    for (const l of f.listens) {
      for (const p of strings(l.port, ctxFor(svc.id))) {
        const n = Number(p);
        if (Number.isFinite(n) && n > 0 && n < 65536) {
          if (!svc.ports.includes(n)) svc.ports.push(n);
          let set = cfg.ports.get(n);
          if (!set) cfg.ports.set(n, (set = new Set()));
          set.add(svc.id);
        }
      }
    }
  }

  // ---------------------------------------------------------------- routers, mounts, prefixes
  const routerKey = (s: Sym | undefined, file: string): string => {
    if (!s) return `file:${file}`;
    if (s.t === 'param') return `param:${s.fn}:${s.i}`;
    const d = prog.deref(s);
    if (d.t === 'obj' && d.fields.__id?.t === 'str') return `id:${d.fields.__id.v}`;
    if (d.t === 'param') return `param:${d.fn}:${d.i}`;
    return `file:${file}`;
  };
  const ownPrefix = new Map<string, string>();
  const parentsOf = new Map<string, { parent: string; prefix: string }[]>();
  const middlewares = new Map<string, string[]>();
  const addParent = (child: string, parent: string, prefix: string) => {
    let l = parentsOf.get(child);
    if (!l) parentsOf.set(child, (l = []));
    if (!l.some((x) => x.parent === parent && x.prefix === prefix)) l.push({ parent, prefix });
  };
  for (const f of facts) {
    const svc = prog.serviceOf(f.file);
    for (const mnt of f.mounts) {
      const parent = routerKey(mnt.parent, f.file);
      const prefix = mnt.prefix ? strings(mnt.prefix, ctxFor(svc?.id))[0] ?? '' : '';
      const child = prog.deref(mnt.child);
      if (child.t === 'obj' && child.fields.__id?.t === 'str') {
        addParent(`id:${child.fields.__id.v}`, parent, prefix);
        const own = child.fields.prefix ? strings(child.fields.prefix, ctxFor(svc?.id))[0] : undefined;
        if (own && !own.startsWith('{')) ownPrefix.set(`id:${child.fields.__id.v}`, own);
      } else if (child.t === 'fn') {
        if (mnt.via === 'register') addParent(`param:${child.id}:0`, parent, prefix);
        else {
          const fn = prog.fns.get(child.id);
          // express "route module" functions taking (app) vs middleware (req,res,next)
          if (fn && fn.params.length <= 1 && /app|router|server|fastify|instance/i.test(fn.params[0] ?? '')) addParent(`param:${child.id}:0`, parent, prefix);
          else {
            let l = middlewares.get(parent);
            if (!l) middlewares.set(parent, (l = []));
            l.push(child.id);
          }
        }
      } else if (child.t === 'param') addParent(`param:${child.fn}:${child.i}`, parent, prefix);
    }
  }
  // routers created from objects with own prefix (koa Router({prefix}))
  const rememberOwn = (s: Sym | undefined, svc?: string) => {
    if (!s) return;
    const d = prog.deref(s);
    if (d.t === 'obj' && d.fields.__id?.t === 'str' && d.fields.prefix && d.fields.prefix.t !== 'null') {
      const own = strings(d.fields.prefix, ctxFor(svc))[0];
      if (own && !own.startsWith('{')) ownPrefix.set(`id:${d.fields.__id.v}`, own);
    }
  };
  // functions called with a router: module.exports = (app) => {...}; require('./routes')(app)
  const aliasParents = (key: string) => {
    const m = key.match(/^param:(.*):(\d+)$/);
    if (!m) return;
    for (const c of prog.callers.get(m[1]) ?? []) {
      const a = c.args[Number(m[2])];
      if (!a) continue;
      const pk = routerKey(a, c.from.split('#')[0]);
      if (pk !== key) addParent(key, pk, '');
    }
  };
  const prefixesOf = (key: string, depth = 0): string[] => {
    if (depth > 10) return [''];
    const own = ownPrefix.get(key) ?? '';
    if (!parentsOf.has(key)) aliasParents(key);
    const ps = parentsOf.get(key);
    if (!ps?.length) return [own];
    const out = new Set<string>();
    for (const p of ps) for (const pp of prefixesOf(p.parent, depth + 1)) out.add(pp + p.prefix + own);
    return [...out].slice(0, 4);
  };
  const middlewaresOf = (key: string, depth = 0): string[] => {
    if (depth > 10) return [];
    const own = middlewares.get(key) ?? [];
    const ps = parentsOf.get(key) ?? [];
    return [...new Set([...ps.flatMap((p) => middlewaresOf(p.parent, depth + 1)), ...own])];
  };
  const globalPrefix = new Map<string, string>();
  for (const f of facts) {
    const svc = prog.serviceOf(f.file);
    for (const gp of f.globalPrefixes) {
      const v = strings(gp, ctxFor(svc?.id))[0];
      if (svc && v && !v.startsWith('{')) globalPrefix.set(svc.id, '/' + v.replace(/^\/|\/$/g, ''));
    }
  }

  // ---------------------------------------------------------------- endpoints
  const nodes = new Map<string, MapNode>();
  const edges = new EdgeSet();
  const endpoints: Endpoint[] = [];
  const handlerFns = new Set<string>();
  const addNode = (n: MapNode): MapNode => {
    const ex = nodes.get(n.id);
    if (ex) {
      if (n.evidence) ex.evidence = dedupeEv([...(ex.evidence ?? []), ...n.evidence]);
      return ex;
    }
    nodes.set(n.id, n);
    return n;
  };

  for (const f of facts) {
    const svc = prog.serviceOf(f.file);
    if (!svc) continue;
    for (const r of f.routes) {
      let valid = r.certain;
      if (!valid) {
        const { kind } = prog.kindOf(r.recv);
        if (kind === 'router' || kind.startsWith('ext:express') || kind.startsWith('ext:fastify') || kind.startsWith('ext:koa') || kind.startsWith('ext:@koa')) valid = true;
        else if (kind === 'axios' || /^ext:(axios|got|superagent|ky|needle|request)/.test(kind)) valid = false;
        else valid = r.handlers.some((h) => !!prog.resolveFn(h));
        if (valid) prog.routeLocs.add(`${r.loc.file}:${r.loc.line}:${r.loc.col}`);
      }
      if (!valid) continue;
      rememberOwn(r.recv, svc.id);
      const key = r.style === 'nest' ? `nest:${svc.id}` : routerKey(r.recv, f.file);
      const subs = strings(r.path, ctxFor(svc.id)).slice(0, 3);
      const prefixes = r.style === 'nest' ? [''] : prefixesOf(key);
      const gp = globalPrefix.get(svc.id) ?? '';
      const roots = [...middlewaresOf(key), ...r.handlers.map((h) => prog.resolveFn(h)).filter((x): x is string => !!x)];
      roots.forEach((x) => handlerFns.add(x));
      for (const pre of prefixes) {
        for (const sub of subs.length ? subs : ['/']) {
          const full = normPath('/' + [gp, pre, sub].join('/').replace(/\/{2,}/g, '/'));
          const method = r.method === 'ALL' || r.method === 'ANY' || r.method === '*' ? 'ANY' : r.method;
          const id = `ep:${svc.id}:${method} ${full}`;
          const node = addNode({ id, kind: 'endpoint', label: `${method} ${full}`, service: svc.id, type: 'http', meta: { method, path: full, style: r.style, health: HEALTH.test(full) || undefined }, evidence: [ev(r.loc)] });
          let ep = endpoints.find((e) => e.node.id === id);
          if (!ep) endpoints.push((ep = { node, svc: svc.id, method, path: full, style: r.style, roots: [] }));
          for (const x of roots) if (!ep.roots.includes(x)) ep.roots.push(x);
          if (r.nestBody?.type) node.request = mergeShapes(node.request, shapeOf(r.nestBody.type, ctxFor(svc.id)));
        }
      }
    }
  }

  // ---------------------------------------------------------------- consumers (sqs, ws, socket.io) & lambdas
  interface Consumer { node: MapNode; svc: string; roots: string[]; match: { kind: 'sqs' | 'sns' | 'eventbridge' | 'ws' | 'sio' | 'schedule'; name: string; source?: string; detailType?: string; path?: string } }
  const consumers: Consumer[] = [];
  const wsServers = new Map<string, MapNode>(); // ws-server __id → node
  for (const f of facts) {
    const svc = prog.serviceOf(f.file);
    if (!svc) continue;
    for (const c of f.consumers) {
      if (c.k === 'ws-server') {
        const p = c.path ? strings(c.path, ctxFor(svc.id))[0] ?? '/' : '/';
        const node = addNode({ id: `ep:${svc.id}:WS ${p}`, kind: 'endpoint', label: `WS ${p}`, service: svc.id, type: 'ws', meta: { path: p }, evidence: [ev(c.loc)] });
        wsServers.set(c.id, node);
        consumers.push({ node, svc: svc.id, roots: [], match: { kind: 'ws', name: p, path: p } });
      }
    }
  }
  for (const f of facts) {
    const svc = prog.serviceOf(f.file);
    if (!svc) continue;
    for (const c of f.consumers) {
      const h = c.k === 'ws-server' ? undefined : prog.resolveFn(c.handler);
      if (h) handlerFns.add(h);
      if (c.k === 'sqs') {
        const q = queueName(strings(c.queue, ctxFor(svc.id))[0] ?? '{queue}');
        const node = addNode({ id: `ep:${svc.id}:SQS ${q}`, kind: 'endpoint', label: `SQS consumer ${q}`, service: svc.id, type: 'sqs-consumer', meta: { queue: q }, evidence: [ev(c.loc)] });
        pushConsumer(node, svc.id, h, { kind: 'sqs', name: q });
      } else if (c.k === 'ws-connection') {
        const d = prog.deref(c.recv);
        const sid = d.t === 'obj' && d.fields.__id?.t === 'str' ? d.fields.__id.v : undefined;
        const isSio = d.t === 'obj' && (d.fields.__kind as any)?.v === 'sio-server';
        let node = sid ? wsServers.get(sid) : undefined;
        if (!node) {
          const p = isSio || svc.deps.has('socket.io') ? '/socket.io' : '/';
          node = addNode({ id: `ep:${svc.id}:WS ${p}`, kind: 'endpoint', label: `WS ${p}`, service: svc.id, type: 'ws', meta: { path: p }, evidence: [ev(c.loc)] });
        }
        pushConsumer(node, svc.id, h, { kind: 'ws', name: String(node.meta?.path ?? '/'), path: String(node.meta?.path ?? '/') });
      } else if (c.k === 'sio-event') {
        if (!svc.deps.has('socket.io') && !svc.deps.has('ws')) continue;
        const node = addNode({ id: `ep:${svc.id}:EVENT ${c.event}`, kind: 'endpoint', label: `EVENT ${c.event}`, service: svc.id, type: 'socket.io', meta: { event: c.event }, evidence: [ev(c.loc)] });
        pushConsumer(node, svc.id, h, { kind: 'sio', name: c.event });
      }
    }
  }
  function pushConsumer(node: MapNode, svc: string, root: string | undefined, match: Consumer['match']) {
    let c = consumers.find((x) => x.node.id === node.id);
    if (!c) consumers.push((c = { node, svc, roots: [], match }));
    if (root && !c.roots.includes(root)) c.roots.push(root);
  }

  // lambdas
  const lambdaNodes: { node: MapNode; name: string; svc?: string; root?: string }[] = [];
  for (const lf of cfg.lambdas) {
    const svc = lf.service ?? services.find((s) => lf.file.startsWith(s.root + path.sep))?.id;
    let root: string | undefined;
    if (lf.handlerFile) {
      const file = [lf.handlerFile, ...['.ts', '.js', '.mjs', '.cjs', '.tsx'].map((e) => lf.handlerFile + e)].find((x) => prog.files.has(x));
      if (file) root = prog.resolveFn(prog.exportOf(file, lf.handlerExport) ?? { t: 'null' });
    }
    if (root) handlerFns.add(root);
    const fnNode = addNode({ id: `fn:lambda:${lf.name}`, kind: 'function', label: `λ ${lf.name}`, service: svc, type: 'lambda', meta: { handler: lf.handlerFile ? `${path.relative(disc.root, lf.handlerFile)}.${lf.handlerExport}` : undefined }, evidence: [{ file: lf.file, line: 1, col: 1 }] });
    lambdaNodes.push({ node: fnNode, name: lf.name, svc, root });
    for (const e of lf.events) {
      if (e.type === 'http') {
        const p = normPath(e.path.replace(/\{([^}+]+)\+?\}/g, ':$1'));
        const method = e.method === 'ANY' || e.method === '*' ? 'ANY' : e.method;
        const id = `ep:${svc}:${method} ${p}`;
        const node = addNode({ id, kind: 'endpoint', label: `${method} ${p}`, service: svc, type: 'http', meta: { method, path: p, style: 'lambda' }, evidence: [{ file: lf.file, line: 1, col: 1 }] });
        let ep = endpoints.find((x) => x.node.id === id);
        if (!ep) endpoints.push((ep = { node, svc: svc ?? '', method, path: p, style: 'lambda', roots: [] }));
        if (root && !ep.roots.includes(root)) ep.roots.push(root);
      } else if (e.type === 'sqs') consumers.push({ node: fnNode, svc: svc ?? '', roots: [], match: { kind: 'sqs', name: e.queue } });
      else if (e.type === 'sns') consumers.push({ node: fnNode, svc: svc ?? '', roots: [], match: { kind: 'sns', name: e.topic } });
      else if (e.type === 'eventbridge') consumers.push({ node: fnNode, svc: svc ?? '', roots: [], match: { kind: 'eventbridge', name: e.bus ?? 'default', source: e.source, detailType: e.detailType } });
      else if (e.type === 'schedule') {
        const sn = addNode({ id: `entry:schedule:${lf.name}`, kind: 'entry', label: `⏱ ${e.rate}`, type: 'schedule', service: svc });
        edges.add({ from: sn.id, to: fnNode.id, protocol: 'invoke', confidence: 0.95, evidence: [{ file: lf.file, line: 1, col: 1 }] });
      }
    }
  }

  // ---------------------------------------------------------------- walk roots
  progress({ phase: 'callgraph' });
  const visitedByHandlers = new Set<string>();
  const walkCache = new Map<string, RootResult>();
  const walk = (fnId: string, svc: string | undefined) => {
    const k = fnId + '@' + svc;
    let r = walkCache.get(k);
    if (!r) {
      r = prog.walk(fnId, svc);
      walkCache.set(k, r);
    }
    return r;
  };
  const pending: { from: MapNode; svc?: string; effects: Effect[] }[] = [];

  for (const ep of endpoints) {
    const svc = svcById.get(ep.svc);
    const bodyPaths = ep.style === 'koa' ? [['request', 'body']] : ep.style === 'hapi' ? [['payload']] : [['body']];
    let req: Shape | undefined = ep.node.request;
    const query = new Set<string>();
    const responses: { status?: number; shape: Shape }[] = [];
    for (const root of ep.roots) {
      const r = walk(root, ep.svc);
      r.visited.forEach((v) => visitedByHandlers.add(v));
      pending.push({ from: ep.node, svc: ep.svc, effects: r.effects });
      for (const rd of r.reads) {
        if (rd.i !== 0) continue;
        for (const bp of bodyPaths) if (startsWith(rd.path, bp) && rd.path.length > bp.length) req = mergeShapes(req, nest(rd.path.slice(bp.length)));
        if (rd.path[0] === 'query' && rd.path[1]) query.add(rd.path[1]);
      }
      for (const v of r.validates) if (v.i === 0 && v.shape && bodyPaths.some((bp) => startsWith(v.path, bp))) req = mergeShapes(v.shape, req);
      const resIdx = ep.style === 'koa' ? 0 : 1;
      for (const rs of r.responds) if (rs.i === resIdx && rs.shape) responses.push({ status: rs.status, shape: rs.shape });
      if (ep.style === 'fastify' || ep.style === 'nest' || ep.style === 'hapi' || ep.style === 'lambda') {
        const fn = prog.fns.get(root);
        for (const ret of fn?.returns ?? []) {
          const d = prog.deref(ret);
          if (ep.style === 'lambda' && d.t === 'obj' && d.fields.statusCode) {
            const st = d.fields.statusCode.t === 'num' ? d.fields.statusCode.v : undefined;
            const sh = shapeOf(d.fields.body, ctxFor(ep.svc));
            if (sh) responses.push({ status: st, shape: sh });
          } else {
            const sh = shapeOf(d, ctxFor(ep.svc));
            if (sh && sh.type !== 'unknown') responses.push({ shape: sh });
          }
        }
      }
    }
    if (req) ep.node.request = req;
    if (responses.length) ep.node.responses = mergeResponses(responses);
    if (query.size) ep.node.meta = { ...ep.node.meta, query: [...query] };
    const params = segments(ep.path).filter((s) => s.startsWith(':') || s.startsWith('{')).map((s) => s.replace(/^[:{]|[}?]$/g, ''));
    if (params.length) ep.node.meta = { ...ep.node.meta, params };
    void svc;
  }
  for (const c of consumers) {
    for (const root of c.roots) {
      const r = walk(root, c.svc);
      r.visited.forEach((v) => visitedByHandlers.add(v));
      pending.push({ from: c.node, svc: c.svc, effects: r.effects });
    }
  }
  for (const l of lambdaNodes) {
    if (!l.root) continue;
    const r = walk(l.root, l.svc);
    r.visited.forEach((v) => visitedByHandlers.add(v));
    pending.push({ from: l.node, svc: l.svc, effects: r.effects });
    // http endpoints of a lambda → invoke edge into the function node
    for (const ep of endpoints) if (ep.roots.includes(l.root)) edges.add({ from: ep.node.id, to: l.node.id, protocol: 'invoke', confidence: 0.95, evidence: ep.node.evidence ?? [] });
  }

  // orphan roots → service entry nodes (frontends, workers, scripts, startup code)
  progress({ phase: 'entries' });
  const handlerRefFns = new Set<string>(handlerFns);
  for (const f of facts) for (const h of f.handlerRefs) {
    const id = prog.resolveFn(h);
    if (id) handlerRefFns.add(id);
  }
  for (const svc of services) {
    if (svc.kind === 'library') continue;
    const entryEffects: Effect[] = [];
    const seenHere = new Set<string>();
    const candidates: string[] = [];
    for (const file of svc.files) {
      const ff = prog.files.get(file);
      if (!ff) continue;
      candidates.push(ff.moduleFn);
      for (const id of ff.fns.keys()) if (id !== ff.moduleFn) candidates.push(id);
    }
    for (const id of candidates) {
      if (handlerRefFns.has(id) || visitedByHandlers.has(id) || seenHere.has(id)) continue;
      if ((prog.incoming.get(id) ?? 0) > 0 && !id.endsWith('#<module>')) continue;
      if (process.env.CLOWNFISH_DEBUG) process.stderr.write(`walk ${id}\n`);
      const r = walk(id, svc.id);
      r.visited.forEach((v) => {
        if (!handlerRefFns.has(v)) seenHere.add(v);
      });
      entryEffects.push(...r.effects.filter((e) => !(e.k === 'http' && e.urls.every((u) => /^\{[^}]*\}$/.test(u)))));
    }
    if (entryEffects.length) {
      const node = addNode({ id: `entry:${svc.id}`, kind: 'entry', label: svc.name, service: svc.id, type: svc.kind, meta: { frameworks: svc.frameworks } });
      pending.push({ from: node, svc: svc.id, effects: entryEffects });
    }
  }

  // ---------------------------------------------------------------- link effects → edges
  progress({ phase: 'link' });
  const epBySvc = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    let l = epBySvc.get(e.svc);
    if (!l) epBySvc.set(e.svc, (l = []));
    l.push(e);
  }
  const subs = [...cfg.subscriptions];

  for (const { from, svc: svcId, effects } of pending) {
    const svc = svcId ? svcById.get(svcId) : undefined;
    for (const e of effects) linkEffect(from, svc, e);
  }
  // runtime SNS subscribe → queue
  for (const s of subs) {
    const tn = addNode({ id: `topic:sns:${s.topic}`, kind: 'topic', label: s.topic, type: 'sns' });
    const qn = addNode({ id: `queue:sqs:${s.queue}`, kind: 'queue', label: s.queue, type: 'sqs' });
    edges.add({ from: tn.id, to: qn.id, protocol: 'subscription', confidence: 0.9, evidence: s.file ? [{ file: s.file, line: 1, col: 1 }] : [] });
  }
  // queues/topics/buses → consumers
  for (const n of [...nodes.values()]) {
    if (n.kind === 'queue' || n.kind === 'topic' || n.kind === 'bus') {
      const name = String(n.label);
      for (const c of consumers) {
        const ok =
          (n.kind === 'queue' && c.match.kind === 'sqs' && sameName(c.match.name, name)) ||
          (n.kind === 'topic' && c.match.kind === 'sns' && sameName(c.match.name, name)) ||
          (n.kind === 'bus' && c.match.kind === 'eventbridge' && sameName(c.match.name, name) && (!c.match.source || !n.meta?.sources || (n.meta.sources as string[]).includes(c.match.source)) && (!c.match.detailType || !n.meta?.detailTypes || (n.meta.detailTypes as string[]).includes(c.match.detailType)));
        if (ok) edges.add({ from: n.id, to: c.node.id, protocol: n.kind === 'queue' ? 'sqs' : n.kind === 'topic' ? 'sns' : 'eventbridge', confidence: 0.85, evidence: c.node.evidence ?? [] });
      }
    }
  }
  // consumers whose queue/topic nobody produced into: still show the source on the left
  for (const c of consumers) {
    if (c.match.kind === 'sqs' || c.match.kind === 'sns' || c.match.kind === 'eventbridge') {
      const id = c.match.kind === 'sqs' ? `queue:sqs:${c.match.name}` : c.match.kind === 'sns' ? `topic:sns:${c.match.name}` : `bus:eventbridge:${c.match.name}`;
      if (!nodes.has(id)) {
        addNode({ id, kind: c.match.kind === 'sqs' ? 'queue' : c.match.kind === 'sns' ? 'topic' : 'bus', label: c.match.name, type: c.match.kind });
        edges.add({ from: id, to: c.node.id, protocol: c.match.kind === 'sqs' ? 'sqs' : c.match.kind === 'sns' ? 'sns' : 'eventbridge', confidence: 0.8, evidence: c.node.evidence ?? [] });
      }
    }
  }

  // external clients → endpoints nobody calls
  if (opts.externalClients !== false) {
    const inbound = new Set([...edges.values()].map((e) => e.to));
    const orphans = [...nodes.values()].filter((n) => n.kind === 'endpoint' && !inbound.has(n.id) && !n.meta?.health && (n.type === 'http' || n.type === 'ws'));
    if (orphans.length) {
      const ext = addNode({ id: 'entry:external-clients', kind: 'entry', label: 'External clients', type: 'client' });
      for (const o of orphans) edges.add({ from: ext.id, to: o.id, protocol: o.type === 'ws' ? 'ws' : 'http', method: o.meta?.method as string | undefined, path: o.meta?.path as string | undefined, request: o.request, response: o.responses?.[0]?.shape, confidence: 0.5, evidence: [], meta: { implicit: true } });
    }
  }

  // sql table columns
  for (const n of nodes.values()) {
    if (n.kind === 'sink' && ['postgres', 'mysql', 'sqlite', 'mssql', 'sql', 'oracle', 'prisma-db'].includes(String(n.type))) {
      const t = cfg.tables.get(String(n.meta?.table ?? '').toLowerCase());
      if (t) n.meta = { ...n.meta, columns: t.columns, schemaFile: t.file };
    }
  }

  // ---------------------------------------------------------------- flows
  const edgeList = [...edges.values()];
  const flows = computeFlows([...nodes.keys()], edgeList);

  const outServices: ServiceInfo[] = services.map(({ pkg: _p, files: _f, deps: _d, ...rest }) => ({ ...rest, root: rest.root }));
  const map: ServiceMap = {
    version: MAP_VERSION,
    generatedAt: new Date().toISOString(),
    root: disc.root,
    stats: { services: services.length, files: allFiles.length, nodes: nodes.size, edges: edgeList.length, flows: flows.length, durationMs: Date.now() - t0 },
    services: outServices,
    nodes: [...nodes.values()],
    edges: edgeList,
    flows,
    warnings: warnings.slice(0, 2000),
  };
  progress({ phase: 'done', message: `${map.stats.nodes} nodes, ${map.stats.edges} edges in ${map.stats.durationMs}ms` });
  return map;

  // ================================================================ linking
  function linkEffect(from: MapNode, svc: DiscoveredService | undefined, e: Effect) {
    const evid = [ev(e.loc)];
    switch (e.k) {
      case 'http': {
        const best = resolveHttp(svc, e.method, e.urls);
        if (!best) {
          warnings.push({ code: 'unresolved-url', message: `${e.method} ${e.urls.join(' | ')}`, file: e.loc.file, line: e.loc.line });
          return;
        }
        let toId: string;
        let response: Shape | undefined = e.resShape;
        if (best.kind === 'endpoint') {
          toId = best.ep.node.id;
          response = response ?? best.ep.node.responses?.find((r) => !r.status || r.status < 300)?.shape;
        } else if (best.kind === 'service') {
          toId = `ep:${best.svc}:${e.method} ${best.path}`;
          addNode({ id: toId, kind: 'endpoint', label: `${e.method} ${best.path}`, service: best.svc, type: 'http', meta: { method: e.method, path: best.path, unmatched: true } });
          warnings.push({ code: 'unmatched-route', message: `${e.method} ${best.path} not found in ${best.svc}`, file: e.loc.file, line: e.loc.line });
        } else if (best.kind === 'infra') {
          toId = `sink:${best.type}:${best.host}`;
          addNode({ id: toId, kind: 'sink', label: `${best.type} · ${best.host}`, type: best.type, meta: { host: best.host } });
        } else {
          toId = `ext:${best.host}`;
          addNode({ id: toId, kind: 'external', label: best.host, type: best.unresolved ? 'unresolved' : 'http', meta: best.unresolved ? { url: e.urls[0] } : undefined });
          if (best.unresolved) warnings.push({ code: 'unresolved-host', message: `${e.method} ${e.urls[0]}`, file: e.loc.file, line: e.loc.line });
        }
        edges.add({ from: from.id, to: toId, protocol: 'http', method: e.method, path: best.path, request: e.body, response, confidence: Math.min(e.confidence, best.conf), evidence: evid, meta: { lib: e.lib, url: e.urls[0] } });
        return;
      }
      case 'ws-connect': {
        const t = resolveWs(svc, e.urls, e.lib);
        if (!t) return;
        edges.add({ from: from.id, to: t.id, protocol: 'ws', path: String(t.meta?.path ?? ''), confidence: 0.8, evidence: evid, meta: { url: e.urls[0] } });
        return;
      }
      case 'ws-emit': {
        const targetSvc = e.urls.map((u) => parseUrl(u)).map((p) => serviceForHost(cfg, p.host, p.port, svc?.id)).find(Boolean);
        const cands = consumers.filter((c) => c.match.kind === 'sio' && c.match.name === e.event && c.svc !== svc?.id);
        const pick = cands.filter((c) => !targetSvc || c.svc === targetSvc);
        for (const c of pick.length ? pick : cands) edges.add({ from: from.id, to: c.node.id, protocol: 'ws', method: 'EMIT', path: e.event, request: e.payload, confidence: targetSvc ? 0.85 : 0.6, evidence: evid });
        return;
      }
      case 'sqs-send': {
        const n = addNode({ id: `queue:sqs:${e.queue}`, kind: 'queue', label: e.queue, type: 'sqs' });
        edges.add({ from: from.id, to: n.id, protocol: 'sqs', method: 'SEND', request: e.body, confidence: 0.9, evidence: evid });
        return;
      }
      case 'sns-publish': {
        const n = addNode({ id: `topic:sns:${e.topic}`, kind: 'topic', label: e.topic, type: 'sns' });
        edges.add({ from: from.id, to: n.id, protocol: 'sns', method: 'PUBLISH', request: e.body, confidence: 0.9, evidence: evid });
        return;
      }
      case 'sns-subscribe':
        subs.push({ topic: e.topic, queue: e.queue, file: e.loc.file });
        return;
      case 'eb-put': {
        const n = addNode({ id: `bus:eventbridge:${e.bus}`, kind: 'bus', label: e.bus, type: 'eventbridge', meta: { sources: [], detailTypes: [] } });
        if (e.source && !(n.meta!.sources as string[]).includes(e.source)) (n.meta!.sources as string[]).push(e.source);
        if (e.detailType && !(n.meta!.detailTypes as string[]).includes(e.detailType)) (n.meta!.detailTypes as string[]).push(e.detailType);
        edges.add({ from: from.id, to: n.id, protocol: 'eventbridge', method: 'PUT', path: [e.source, e.detailType].filter(Boolean).join(' / ') || undefined, request: e.detail, confidence: 0.9, evidence: evid });
        return;
      }
      case 'lambda-invoke': {
        const l = lambdaNodes.find((x) => sameName(x.name, e.fn) || e.fn.endsWith('-' + x.name) || e.fn.endsWith(x.name));
        const toId = l?.node.id ?? `ext:lambda:${e.fn}`;
        if (!l) addNode({ id: toId, kind: 'external', label: `λ ${e.fn}`, type: 'lambda' });
        edges.add({ from: from.id, to: toId, protocol: 'lambda', method: 'INVOKE', request: e.payload, confidence: l ? 0.85 : 0.6, evidence: evid });
        return;
      }
      case 'sink': {
        const label = e.db === 'redis' ? `redis · ${e.name}` : `${e.db} · ${e.name}`;
        const id = `sink:${e.db}:${e.name}`;
        const n = addNode({ id, kind: 'sink', label, type: e.db, meta: { [e.db === 'redis' ? 'key' : e.db === 's3' ? 'bucket' : e.db === 'elasticsearch' ? 'index' : e.db === 'mongo' ? 'collection' : 'table']: e.name, table: e.name } });
        if (e.meta?.key && e.db === 's3') n.meta = { ...n.meta, keys: [...new Set([...((n.meta?.keys as string[]) ?? []), String(e.meta.key)])].slice(0, 20) };
        const proto: MapEdge['protocol'] = e.db === 'redis' ? 'redis' : e.db === 'mongo' ? 'mongo' : e.db === 'dynamodb' ? 'dynamodb' : e.db === 's3' ? 's3' : e.db === 'elasticsearch' ? 'elasticsearch' : 'sql';
        edges.add({ from: from.id, to: id, protocol: proto, operations: [e.op], request: e.data, confidence: e.confidence, evidence: evid, meta: e.meta?.sql ? { sql: [e.meta.sql] } : undefined });
        return;
      }
    }
  }

  type HttpTarget =
    | { kind: 'endpoint'; ep: Endpoint; path: string; conf: number }
    | { kind: 'service'; svc: string; path: string; conf: number }
    | { kind: 'infra'; type: string; host: string; path: string; conf: number }
    | { kind: 'external'; host: string; path: string; conf: number; unresolved?: boolean };

  function bestRoute(list: Endpoint[], method: string, p: string): { ep: Endpoint; score: number }[] {
    const out: { ep: Endpoint; score: number }[] = [];
    for (const ep of list) {
      if (!(ep.method === 'ANY' || method === 'ANY' || ep.method === method)) continue;
      const s = matchScore(ep.path, p);
      if (s >= 0) out.push({ ep, score: s + (ep.method === method ? 0.5 : 0) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function resolveHttp(svc: DiscoveredService | undefined, method: string, urls: string[]): HttpTarget | undefined {
    const results: HttpTarget[] = [];
    for (const u of urls) {
      if (/^\{[^}]*\}$/.test(u)) continue;
      let p = parseUrl(u);
      if (!p.host) {
        const px = applyProxy(cfg, svc, p);
        if (px) p = px;
      }
      const target = serviceForHost(cfg, p.host, p.port, svc?.id);
      if (target) {
        const m = bestRoute(epBySvc.get(target) ?? [], method, p.path);
        if (m.length) results.push({ kind: 'endpoint', ep: m[0].ep, path: m[0].ep.path, conf: m[0].score >= segments(p.path).length * 3 ? 0.95 : 0.85 });
        else results.push({ kind: 'service', svc: target, path: p.path, conf: 0.6 });
        continue;
      }
      if (p.host && !p.host.startsWith('{')) {
        const infra = cfg.infraHosts.get(p.host.toLowerCase());
        if (infra) results.push({ kind: 'infra', type: infra, host: p.host, path: p.path, conf: 0.8 });
        else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(p.host)) {
          const m = bestRoute(endpoints.filter((x) => x.svc !== svc?.id), method, p.path);
          if (m.length) results.push({ kind: 'endpoint', ep: m[0].ep, path: m[0].ep.path, conf: m.length > 1 && m[1].score === m[0].score ? 0.45 : 0.7 });
          else results.push({ kind: 'external', host: `${p.host}${p.port ? ':' + p.port : ''}`, path: p.path, conf: 0.5 });
        } else results.push({ kind: 'external', host: p.host, path: p.path, conf: 0.85 });
        continue;
      }
      // relative or unresolved host → match by path across services
      const m = bestRoute(endpoints.filter((x) => x.svc !== svc?.id), method, p.path);
      const strong = m.filter((x) => x.score >= 3);
      if (strong.length) results.push({ kind: 'endpoint', ep: strong[0].ep, path: strong[0].ep.path, conf: strong.length > 1 && strong[1].score === strong[0].score && strong[1].ep.svc !== strong[0].ep.svc ? 0.45 : 0.7 });
      else if (p.host?.startsWith('{')) results.push({ kind: 'external', host: p.host, path: p.path, conf: 0.3, unresolved: true });
      else if (p.path !== '/' && segments(p.path).some((s) => !s.startsWith('{'))) results.push({ kind: 'external', host: '(same-origin)', path: p.path, conf: 0.3, unresolved: true });
    }
    const rank = (r: HttpTarget) => (r.kind === 'endpoint' ? 4 : r.kind === 'service' ? 3 : r.kind === 'infra' ? 2 : r.kind === 'external' && !r.unresolved ? 1.5 : 1) + r.conf;
    return results.sort((a, b) => rank(b) - rank(a))[0];
  }

  function resolveWs(svc: DiscoveredService | undefined, urls: string[], lib: string): MapNode | undefined {
    const wsNodes = consumers.filter((c) => c.match.kind === 'ws');
    for (const u of urls) {
      const p = parseUrl(u);
      if (lib === 'socket.io' && p.path === '/') p.path = '/socket.io';
      const target = serviceForHost(cfg, p.host, p.port, svc?.id);
      const pool = wsNodes.filter((c) => (target ? c.svc === target : c.svc !== svc?.id));
      const exact = pool.find((c) => normPath(c.match.path ?? '/') === p.path) ?? (pool.length === 1 || target ? pool[0] : undefined);
      if (exact) return exact.node;
      if (p.host && !p.host.startsWith('{') && !target) return addNode({ id: `ext:${p.host}`, kind: 'external', label: p.host, type: 'ws' });
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- helpers
class EdgeSet {
  private m = new Map<string, MapEdge>();
  add(e: Omit<MapEdge, 'id'>) {
    const id = `${e.from}->${e.to}|${e.protocol}|${e.method ?? ''}|${e.path ?? ''}`;
    const ex = this.m.get(id);
    if (!ex) {
      this.m.set(id, { id, ...e, evidence: dedupeEv(e.evidence), operations: e.operations ? [...new Set(e.operations)] : undefined });
      return;
    }
    ex.evidence = dedupeEv([...ex.evidence, ...e.evidence]).slice(0, 30);
    if (e.operations) ex.operations = [...new Set([...(ex.operations ?? []), ...e.operations])];
    ex.request = mergeShapes(ex.request, e.request);
    ex.response = mergeShapes(ex.response, e.response);
    ex.confidence = Math.max(ex.confidence, e.confidence);
    if (e.meta?.sql && ex.meta) ex.meta.sql = [...new Set([...((ex.meta.sql as string[]) ?? []), ...(e.meta.sql as string[])])].slice(0, 10);
  }
  values() {
    return this.m.values();
  }
}

function ev(l: Loc): Evidence {
  return { file: l.file, line: l.line, col: l.col, snippet: l.snippet };
}

function dedupeEv(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.file}:${e.line}:${e.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function startsWith(a: string[], b: string[]) {
  return b.every((x, i) => a[i] === x);
}

function nest(p: string[]): Shape {
  let sh: Shape = { type: 'unknown', source: 'usage' };
  for (let i = p.length - 1; i >= 0; i--) sh = { type: 'object', fields: { [p[i]]: sh }, source: 'usage' };
  return sh;
}

function mergeResponses(list: { status?: number; shape: Shape }[]) {
  const by = new Map<string, { status?: number; shape: Shape }>();
  for (const r of list) {
    const k = String(r.status ?? '');
    const ex = by.get(k);
    by.set(k, ex ? { status: r.status, shape: mergeShapes(ex.shape, r.shape) ?? r.shape } : r);
  }
  return [...by.values()].sort((a, b) => (a.status ?? 200) - (b.status ?? 200));
}

function sameName(a: string, b: string) {
  if (!a || !b) return false;
  const n = (s: string) => s.toLowerCase().replace(/\.fifo$/, '');
  return n(a) === n(b) || n(queueName(a)) === n(queueName(b)) || n(arnName(a)) === n(arnName(b));
}

export function computeFlows(nodeIds: string[], edges: MapEdge[], cap = 2000): string[][] {
  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const id of nodeIds) {
    out.set(id, []);
    inDeg.set(id, 0);
  }
  for (const e of edges) {
    out.get(e.from)?.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const flows: string[][] = [];
  const sources = nodeIds.filter((id) => (inDeg.get(id) ?? 0) === 0 && (out.get(id)?.length ?? 0) > 0);
  const dfs = (id: string, pathAcc: string[], seen: Set<string>) => {
    if (flows.length >= cap) return;
    const next = (out.get(id) ?? []).filter((n) => !seen.has(n));
    if (!next.length) {
      if (pathAcc.length > 1) flows.push([...pathAcc]);
      return;
    }
    if (pathAcc.length > 30) return;
    for (const n of next) {
      seen.add(n);
      pathAcc.push(n);
      dfs(n, pathAcc, seen);
      pathAcc.pop();
      seen.delete(n);
    }
  };
  for (const s of sources) dfs(s, [s], new Set([s]));
  return flows;
}

export { fs };
