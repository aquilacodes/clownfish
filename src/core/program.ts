// Whole-program view: module resolution, symbol dereferencing, call-graph traversal with
// argument substitution, and interpretation of raw ops into resolved "effects".
import fs from 'node:fs';
import path from 'node:path';
import type { FileFacts, FnFacts, ClassFacts, Op, Loc } from './analyze.ts';
import { extKey, plural } from './analyze.ts';
import type { DiscoveredService } from './discover.ts';
import type { Config } from './config.ts';
import { queueName, arnName } from './config.ts';
import type { Shape, Evidence } from './model.ts';
import { member, strings, shapeOf, subst, substAny, mergeShapes, type Sym, type ResolveCtx } from './sym.ts';

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export type Effect = (
  | { k: 'http'; lib: string; method: string; urls: string[]; body?: Shape; resShape?: Shape; confidence: number }
  | { k: 'ws-connect'; urls: string[]; lib: string }
  | { k: 'ws-emit'; urls: string[]; event: string; payload?: Shape }
  | { k: 'sqs-send'; queue: string; body?: Shape }
  | { k: 'sns-publish'; topic: string; body?: Shape }
  | { k: 'eb-put'; bus: string; source?: string; detailType?: string; detail?: Shape }
  | { k: 'lambda-invoke'; fn: string; payload?: Shape }
  | { k: 'sink'; db: string; name: string; op: string; data?: Shape; meta?: Record<string, unknown>; confidence: number }
  | { k: 'sns-subscribe'; topic: string; queue: string }
) & { loc: Loc };

export interface RootResult {
  effects: Effect[];
  /** root-param reads (request fields) */
  reads: { i: number; path: string[]; loc: Loc }[];
  responds: { i: number; status?: number; shape?: Shape; style: string }[];
  validates: { i: number; path: string[]; shape?: Shape }[];
  visited: Set<string>;
}

export class Program {
  files = new Map<string, FileFacts>();
  fileService = new Map<string, DiscoveredService>();
  fns = new Map<string, FnFacts>();
  classes = new Map<string, ClassFacts>();
  services: DiscoveredService[];
  cfg: Config;
  private modCache = new Map<string, string | null>();
  private nsCache = new Map<string, Sym>();
  private tsPaths = new Map<string, { baseUrl: string; paths: [string, string[]][] } | null>();
  /** fnId → incoming call count (resolved without substitution). */
  incoming = new Map<string, number>();
  /** fnId → call sites targeting it (caller fn id + args). */
  callers = new Map<string, { from: string; args: (Sym | undefined)[] }[]>();
  /** ambiguous route/http locations decided as routes. */
  routeLocs = new Set<string>();
  envSvc: string | undefined;
  private retStack = new Set<string>();

  constructor(services: DiscoveredService[], cfg: Config, facts: FileFacts[]) {
    this.services = services;
    this.cfg = cfg;
    for (const s of services) for (const f of s.files) this.fileService.set(f, s);
    for (const f of facts) {
      this.files.set(f.file, f);
      for (const [id, fn] of f.fns) this.fns.set(id, fn);
      for (const [id, c] of f.classes) this.classes.set(id, c);
    }
    // incoming-call index
    for (const fn of this.fns.values()) {
      for (const c of fn.calls) {
        const t = this.resolveFn(c.target);
        if (!t || t === fn.id) continue;
        this.incoming.set(t, (this.incoming.get(t) ?? 0) + 1);
        let l = this.callers.get(t);
        if (!l) this.callers.set(t, (l = []));
        l.push({ from: fn.id, args: c.args });
      }
    }
  }

  serviceOf(file: string): DiscoveredService | undefined {
    return this.fileService.get(file);
  }

  // ------------------------------------------------------------ resolution context
  ctx(svcId?: string): ResolveCtx {
    return {
      env: (name) => {
        const sid = svcId ?? this.envSvc;
        const v = sid ? this.cfg.env.get(sid)?.get(name) : undefined;
        return v;
      },
      ref: (s) => {
        const d = this.deref(s);
        return d === s ? undefined : d;
      },
      type: (name, file) => this.typeShape(name, file),
      param: (fn, i) => {
        const pt = this.fns.get(fn)?.paramTypes[i];
        if (!pt || pt.t === 'inst' || pt.t === 'obj') return undefined;
        return shapeOf(pt, this.ctx(svcId));
      },
    };
  }

  // ------------------------------------------------------------ module resolution
  resolveModule(from: string, source: string): string | undefined {
    const key = from + '\0' + source;
    if (this.modCache.has(key)) return this.modCache.get(key) ?? undefined;
    const r = this.resolveModuleInner(from, source);
    this.modCache.set(key, r ?? null);
    return r;
  }

  private tryFile(base: string): string | undefined {
    if (this.files.has(base)) return base;
    for (const e of EXTS) if (this.files.has(base + e)) return base + e;
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    if (stripped !== base) for (const e of EXTS) if (this.files.has(stripped + e)) return stripped + e;
    for (const e of EXTS) if (this.files.has(path.join(base, 'index' + e))) return path.join(base, 'index' + e);
    return undefined;
  }

  private resolveModuleInner(from: string, source: string): string | undefined {
    if (source.startsWith('.') || source.startsWith('/')) return this.tryFile(path.resolve(path.dirname(from), source));
    const svc = this.serviceOf(from);
    if (svc) {
      const tp = this.getTsPaths(svc.root);
      if (tp) {
        for (const [pat, targets] of tp.paths) {
          const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)').replace('*', '(.*)') + '$');
          const m = source.match(re);
          if (!m) continue;
          for (const t of targets) {
            const r = this.tryFile(path.resolve(tp.baseUrl, t.replace('*', m[1] ?? '')));
            if (r) return r;
          }
        }
        const r = this.tryFile(path.resolve(tp.baseUrl, source));
        if (r && !source.includes('/') === false) return r;
      }
    }
    // workspace packages by name
    const parts = source.split('/');
    const pkgName = source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = parts.slice(source.startsWith('@') ? 2 : 1).join('/');
    const pkg = this.services.find((s) => s.pkg.name === pkgName);
    if (!pkg) return undefined;
    if (sub) return this.tryFile(path.join(pkg.root, sub)) ?? this.tryFile(path.join(pkg.root, 'src', sub));
    const exp = pkg.pkg.exports;
    const entries = [
      typeof exp === 'string' ? exp : exp?.['.']?.import ?? exp?.['.']?.require ?? exp?.['.']?.default ?? (typeof exp?.['.'] === 'string' ? exp['.'] : undefined),
      pkg.pkg.source,
      pkg.pkg.module,
      pkg.pkg.main,
      'src/index',
      'index',
      'lib/index',
    ].filter(Boolean) as string[];
    for (const e of entries) {
      const r = this.tryFile(path.join(pkg.root, e)) ?? this.tryFile(path.join(pkg.root, e.replace(/^(dist|build|lib)\//, 'src/')));
      if (r) return r;
    }
    return undefined;
  }

  private getTsPaths(root: string) {
    if (this.tsPaths.has(root)) return this.tsPaths.get(root)!;
    let out: { baseUrl: string; paths: [string, string[]][] } | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      try {
        const raw = fs.readFileSync(path.join(root, name), 'utf8');
        const json = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
        const co = json.compilerOptions ?? {};
        if (co.baseUrl || co.paths) {
          out = { baseUrl: path.resolve(root, co.baseUrl ?? '.'), paths: Object.entries<string[]>(co.paths ?? {}) };
          break;
        }
      } catch {}
    }
    this.tsPaths.set(root, out);
    return out;
  }

  // ------------------------------------------------------------ exports & deref
  exportOf(file: string, name: string, depth = 0): Sym | undefined {
    const f = this.files.get(file);
    if (!f || depth > 15) return undefined;
    if (name === '*') return this.namespace(file, depth);
    if (name === 'default') return f.exports.get('default') ?? f.exports.get('*cjs') ?? this.namespace(file, depth);
    const direct = f.exports.get(name);
    if (direct) return direct;
    const cjs = f.exports.get('*cjs');
    if (cjs) {
      const d = this.deref(cjs, depth + 1);
      if (d.t === 'obj' && name in d.fields) return d.fields[name];
      if (d.t === 'fn' || d.t === 'class') return member(d, name);
    }
    for (const s of f.stars) {
      const m = this.resolveModule(file, s);
      if (m) {
        const v = this.exportOf(m, name, depth + 1);
        if (v) return v;
      }
    }
    return undefined;
  }

  private namespace(file: string, depth: number): Sym {
    const f = this.files.get(file)!;
    const cjs = f.exports.get('*cjs');
    if (cjs) return cjs;
    const cached = this.nsCache.get(file);
    if (cached) return cached;
    const fields: Record<string, Sym> = {};
    for (const s of f.stars) {
      const m = this.resolveModule(file, s);
      const ns = m && depth < 10 ? this.deref(this.namespace(m, depth + 1)) : undefined;
      if (ns?.t === 'obj') Object.assign(fields, ns.fields);
    }
    for (const [k, v] of f.exports) if (k !== 'default') fields[k] = v;
    const out: Sym = { t: 'obj', fields };
    this.nsCache.set(file, out);
    return out;
  }

  deref(s: Sym | undefined, depth = 0): Sym {
    if (!s) return { t: 'null' };
    if (depth > 25) return s;
    if (s.t === 'ref') {
      const mod = this.resolveModule(s.file, s.source);
      if (!mod) {
        const name = s.source.replace(/^node:/, '');
        return { t: 'ext', mod: name, path: [...(s.imported === '*' || s.imported === 'default' ? [] : [s.imported]), ...(s.path ?? [])] };
      }
      let v = this.exportOf(mod, s.imported, depth);
      if (!v) return s;
      v = this.deref(v, depth + 1);
      for (const k of s.path ?? []) v = this.deref(member(v, k), depth + 1);
      return v;
    }
    if (s.t === 'inst') {
      const cls = this.deref(s.cls, depth + 1);
      if (!s.path?.length) return cls === s.cls ? s : { t: 'inst', cls };
      if (cls.t === 'class') {
        const [k, ...rest] = s.path;
        const r = this.classMember(cls.id, k, depth);
        if (!r) return s;
        let v = this.deref(r, depth + 1);
        for (const kk of rest) v = this.deref(member(v, kk), depth + 1);
        return v;
      }
      if (cls.t === 'ext') return { t: 'ext', mod: cls.mod, path: [...cls.path, '#inst', ...s.path] };
      if (cls.t === 'obj' || cls.t === 'fn') {
        // instance of something that resolved to an object (e.g. exported singleton) → member path
        let v: Sym = cls;
        for (const k of s.path) v = this.deref(member(v, k), depth + 1);
        return v;
      }
      return s;
    }
    if (s.t === 'ret') {
      if (depth > 10 || this.retStack.size > 6) return s;
      const fid = this.resolveFn(s.fn);
      const fn = fid ? this.fns.get(fid) : undefined;
      if (!fn || !fn.returns.length || this.retStack.has(fn.id)) return s;
      this.retStack.add(fn.id);
      try {
        let pick: Sym | undefined;
        for (const r of fn.returns.slice(0, 4)) {
          const d = this.deref(subst(r, fn.id, s.args), depth + 1);
          if (d.t !== 'dyn' && d.t !== 'null' && d.t !== 'ret') {
            pick = d;
            break;
          }
        }
        if (!pick) return s;
        let v = pick;
        for (const k of s.path ?? []) v = this.deref(member(v, k), depth + 1);
        return v;
      } finally {
        this.retStack.delete(fn.id);
      }
    }
    if (s.t === 'alt') {
      // prefer an alternative that resolves to something concrete (objects/functions)
      for (const o of s.opts) {
        const d = this.deref(o, depth + 1);
        if (d.t === 'obj' || d.t === 'fn' || d.t === 'class') return d;
      }
    }
    return s;
  }

  classMember(classId: string, key: string, depth = 0): Sym | undefined {
    const c = this.classes.get(classId);
    if (!c || depth > 10) return undefined;
    if (c.methods.includes(key)) return { t: 'fn', id: `${classId}.${key}` };
    if (c.fields[key]) return c.fields[key];
    if (c.superClass) {
      const sup = this.deref(c.superClass, depth + 1);
      if (sup.t === 'class') return this.classMember(sup.id, key, depth + 1);
      if (sup.t === 'ext') return { t: 'ext', mod: sup.mod, path: [...sup.path, '#inst', key] };
    }
    return undefined;
  }

  resolveFn(s: Sym | undefined): string | undefined {
    if (!s) return undefined;
    const d = this.deref(s);
    if (d.t === 'fn' && this.fns.has(d.id)) return d.id;
    if (d.t === 'class') {
      const ctor = `${d.id}.constructor`;
      return this.fns.has(ctor) ? ctor : undefined;
    }
    return undefined;
  }

  /** Classify the runtime "kind" of a receiver symbol (axios client, redis client, model ...). */
  kindOf(s: Sym | undefined): { kind: string; obj?: Sym } {
    if (!s) return { kind: '' };
    const d = this.deref(s);
    if (d.t === 'obj' && d.fields.__kind?.t === 'str') return { kind: d.fields.__kind.v, obj: d };
    if (d.t === 'ext') return { kind: 'ext:' + extKey(d), obj: d };
    if (d.t === 'class') return { kind: 'class', obj: d };
    if (d.t === 'inst') {
      const c = this.deref(d.cls);
      if (c.t === 'class') {
        // class extending PrismaClient etc.
        const ext = this.superExt(c.id);
        if (ext) return { kind: 'inst-ext:' + ext, obj: c };
        return { kind: 'inst', obj: c };
      }
      if (c.t === 'ext') return { kind: 'ext:' + extKey(c) + '#inst', obj: c };
    }
    return { kind: d.t === 'dyn' || d.t === 'param' || d.t === 'ref' ? 'unknown' : d.t, obj: d };
  }

  superExt(classId: string, depth = 0): string | undefined {
    const c = this.classes.get(classId);
    if (!c?.superClass || depth > 8) return undefined;
    const sup = this.deref(c.superClass);
    if (sup.t === 'ext') return extKey(sup);
    if (sup.t === 'class') return this.superExt(sup.id, depth + 1);
    return undefined;
  }

  // ------------------------------------------------------------ types
  typeShape(name: string, file: string, depth = 0): Shape | undefined {
    if (depth > 4) return undefined;
    const f = this.files.get(file);
    let sh = f?.types.get(name);
    if (!sh && f) {
      const imp = f.imports.get(name);
      if (imp) {
        const mod = this.resolveModule(file, imp.source);
        if (mod) {
          const target = imp.imported === 'default' || imp.imported === '*' ? name : imp.imported;
          sh = this.files.get(mod)?.types.get(target);
          if (sh) file = mod;
          else {
            // re-exported?
            const ex = this.exportOf(mod, target);
            if (ex?.t === 'ref') return this.typeShape(ex.imported, this.resolveModule(mod, ex.source) ?? mod, depth + 1);
          }
        }
      }
    }
    if (!sh) {
      const svc = this.serviceOf(file);
      for (const sf of svc?.files ?? []) {
        const t = this.files.get(sf)?.types.get(name);
        if (t) {
          sh = t;
          file = sf;
          break;
        }
      }
    }
    if (!sh) return undefined;
    return this.expandShape(sh, file, depth + 1);
  }

  private expandShape(sh: Shape, file: string, depth: number): Shape {
    if (depth > 4) return sh;
    if (sh.type === 'object' && sh.typeName && !sh.fields) {
      const r = this.typeShape(sh.typeName, file, depth + 1);
      return r ? { ...r, typeName: sh.typeName, optional: sh.optional } : sh;
    }
    if (sh.type === 'array' && sh.items) return { ...sh, items: this.expandShape(sh.items, file, depth + 1) };
    if (sh.fields) {
      const fields: Record<string, Shape> = {};
      for (const [k, v] of Object.entries(sh.fields)) {
        if (k.startsWith('...')) {
          const base = this.typeShape(k.slice(3), file, depth + 1);
          if (base?.fields) Object.assign(fields, base.fields);
          continue;
        }
        fields[k] = this.expandShape(v, file, depth + 1);
      }
      return { ...sh, fields };
    }
    return sh;
  }

  // ------------------------------------------------------------ traversal
  /**
   * Walk the call graph from `rootId`, instantiating ops with call-site arguments.
   * Root params remain symbolic (so request/response usage can be attributed to the root).
   */
  walk(rootId: string, svcId: string | undefined, rootArgs?: (Sym | undefined)[]): RootResult {
    const res: RootResult = { effects: [], reads: [], responds: [], validates: [], visited: new Set() };
    const ctx = this.ctx(svcId);
    let budget = 4000;
    const seen = new Set<string>();
    const frames: [string, (Sym | undefined)[]][] = [];
    const applyFrames = <T>(v: T): T => {
      let out = v;
      for (let i = frames.length - 1; i >= 0; i--) out = substAny(out, frames[i][0], frames[i][1]);
      return out;
    };
    const visit = (fnId: string, args: (Sym | undefined)[] | undefined, depth: number, stack: Set<string>) => {
      if (--budget < 0 || depth > 14 || stack.has(fnId)) return;
      const fn = this.fns.get(fnId);
      if (!fn) return;
      const key = fnId + '|' + (args ? JSON.stringify(args).slice(0, 400) : '');
      if (seen.has(key)) return;
      seen.add(key);
      res.visited.add(fnId);
      if (args) frames.push([fnId, args]);
      stack.add(fnId);
      for (const raw of fn.ops) {
        const op = applyFrames(raw);
        this.interpret(op, rootId, res, ctx, svcId);
      }
      for (const c of fn.calls) {
        const target = applyFrames(c.target);
        const tid = this.resolveFn(target);
        if (!tid) continue;
        const callArgs = c.args.map((a) => (a ? applyFrames(a) : a));
        // passing the receiver object is irrelevant; method calls just use declared params
        visit(tid, c.callback ? undefined : callArgs, depth + 1, stack);
      }
      stack.delete(fnId);
      if (args) frames.pop();
    };
    visit(rootId, rootArgs, 0, new Set());
    return res;
  }

  // ------------------------------------------------------------ op interpretation
  private interpret(op: Op, rootId: string, res: RootResult, ctx: ResolveCtx, svcId?: string) {
    const loc = op.loc;
    const strs = (s: Sym | undefined) => strings(s, ctx);
    const shape = (s: Sym | undefined) => (s ? shapeOf(s, ctx) : undefined);
    const isRootParam = (s: Sym): s is Extract<Sym, { t: 'param' }> => s.t === 'param' && s.fn === rootId;
    const push = (e: any) => res.effects.push({ ...e, loc });

    switch (op.k) {
      case 'reads':
        if (isRootParam(op.sym)) res.reads.push({ i: op.sym.i, path: op.sym.path ?? [], loc });
        return;
      case 'respond':
        if (isRootParam(op.res)) res.responds.push({ i: op.res.i, status: op.status, shape: shape(op.body), style: op.style });
        return;
      case 'validate': {
        if (isRootParam(op.target)) {
          const sch = this.deref(op.schema);
          let sh = shape(sch);
          if (sch.t === 'class' || (sch.t === 'dyn' && false)) sh = this.typeShape(this.classes.get(sch.id)?.name ?? '', this.classes.get(sch.id)?.file ?? '');
          res.validates.push({ i: op.target.i, path: op.target.path ?? [], shape: sh });
        }
        return;
      }
      case 'http': {
        const locKey = `${loc.file}:${loc.line}:${loc.col}`;
        if (op.guard === 'client' && this.routeLocs.has(locKey)) return;
        let confidence = 0.9;
        let base = op.base;
        if (op.recv) {
          const { kind, obj } = this.kindOf(op.recv);
          if (kind === 'router' || kind === 'redis' || kind === 'model' || kind === 'repo' || kind === 'mongo-coll' || kind === 'sql' || kind === 'knex' || kind === 'es' || kind === 'prisma' || kind.startsWith('ext:express') || kind.startsWith('ext:fastify') || kind.startsWith('ext:ioredis') || kind.startsWith('ext:redis')) return;
          if (kind === 'map') return;
          if (kind === 'axios' && obj?.t === 'obj') base = obj.fields.baseURL ?? obj.fields.prefixUrl;
          else if (op.guard === 'client') {
            confidence = kind.startsWith('ext:') ? 0.85 : 0.6;
            // unknown receiver: only keep calls whose URL really looks like a URL/path
            if (!kind.startsWith('ext:') && !strs(op.url).some((u) => /^(\/|https?:\/\/|wss?:\/\/)/.test(u))) return;
          }
        }
        const method = (strs(op.method)[0] ?? 'GET').toUpperCase();
        const paths = strs(op.url);
        const bases = base ? strs(base).filter((b) => !/^\{(baseURL|prefixUrl|x)\}$/.test(b)) : [];
        const urls: string[] = [];
        for (const p of paths.length ? paths : ['/']) {
          if (/^[a-z]+:\/\//i.test(p) || !bases.length) urls.push(p);
          else for (const b of bases) urls.push(joinUrl(b, p));
        }
        push({ k: 'http', lib: op.lib, method: /^\{/.test(method) ? 'ANY' : method, urls: [...new Set(urls)].slice(0, 8), body: shape(op.body), resShape: op.resType ? shape(op.resType) : undefined, confidence });
        return;
      }
      case 'ws-connect':
        push({ k: 'ws-connect', urls: strs(op.url), lib: op.lib });
        return;
      case 'ws-emit': {
        const { kind, obj } = this.kindOf(op.recv);
        if ((kind !== 'sio-client' && kind !== 'ws-client') || obj?.t !== 'obj') return;
        const ev = strs(op.event)[0];
        if (!ev) return;
        push({ k: 'ws-emit', urls: strs(obj.fields.url), event: ev, payload: shape(op.payload) });
        return;
      }
      case 'aws': {
        const input = this.deref(op.input);
        const need = (op as any).needKey as string | undefined;
        if (need && (input.t !== 'obj' || !(need in input.fields))) return;
        const f = (k: string) => (input.t === 'obj' ? input.fields[k] : member(input, k));
        const first = (k: string) => strs(f(k))[0];
        switch (op.svc) {
          case 'sqs': {
            const q = first('QueueUrl');
            if (!q) return;
            if (op.action.startsWith('SendMessage')) push({ k: 'sqs-send', queue: queueName(q), body: op.action === 'SendMessage' ? shape(f('MessageBody')) : undefined });
            return;
          }
          case 'sns': {
            const t = first('TopicArn') ?? first('TargetArn');
            if (!t) return;
            if (op.action === 'Subscribe') {
              const proto = first('Protocol');
              const ep = first('Endpoint');
              if (proto === 'sqs' && ep) push({ k: 'sns-subscribe', topic: arnName(t), queue: queueName(ep) });
              return;
            }
            push({ k: 'sns-publish', topic: arnName(t), body: shape(f('Message')) });
            return;
          }
          case 'eventbridge': {
            const entries = this.deref(f('Entries'));
            const e = entries.t === 'arr' && entries.item ? this.deref(entries.item) : entries;
            const g = (k: string) => strs(e.t === 'obj' ? e.fields[k] : undefined)[0];
            push({ k: 'eb-put', bus: g('EventBusName') ?? 'default', source: g('Source'), detailType: g('DetailType'), detail: shape(e.t === 'obj' ? e.fields.Detail : undefined) });
            return;
          }
          case 'lambda': {
            const fnName = first('FunctionName');
            if (fnName) push({ k: 'lambda-invoke', fn: arnName(fnName), payload: shape(f('Payload')) });
            return;
          }
          case 's3': {
            const b = first('Bucket');
            if (!b) return;
            push({ k: 'sink', db: 's3', name: b, op: op.action, meta: { key: first('Key') }, confidence: 0.9 });
            return;
          }
          case 'dynamodb': {
            let t = first('TableName');
            if (!t && (op.action === 'BatchWrite' || op.action === 'BatchGet')) {
              const ri = this.deref(f('RequestItems'));
              if (ri.t === 'obj') t = Object.keys(ri.fields)[0];
            }
            if (!t) return;
            push({ k: 'sink', db: 'dynamodb', name: t, op: op.action, data: shape(f('Item')), meta: { key: shapeKeys(this.deref(f('Key'))) }, confidence: 0.9 });
            return;
          }
        }
        return;
      }
      case 'sql': {
        const db = this.sqlDialect(op.recv, svcId);
        for (const q of strs(op.sql)) {
          if (!/^\s*(select|insert|update|delete|with|merge|replace|upsert|call|exec)\b/i.test(q)) continue;
          for (const t of sqlTables(q)) push({ k: 'sink', db, name: t.table, op: t.op, meta: { sql: q.replace(/\s+/g, ' ').slice(0, 300) }, confidence: 0.9 });
        }
        return;
      }
      case 'knex': {
        const { kind } = this.kindOf(op.recv);
        if (kind !== 'knex' && kind !== 'unknown' && kind !== 'ext:knex') return;
        const t = strs(op.table)[0];
        if (!t || t.startsWith('{')) return;
        push({ k: 'sink', db: this.sqlDialect(undefined, svcId), name: t.replace(/\s+as\s+.*$/i, ''), op: op.op, confidence: kind === 'knex' ? 0.9 : 0.7 });
        return;
      }
      case 'store': {
        const tgt = this.storeTarget(op.recv);
        if (!tgt) return;
        const name = strs(tgt.table)[0];
        if (!name) return;
        push({ k: 'sink', db: tgt.db === 'sql' ? this.sqlDialect(undefined, svcId) : tgt.db, name, op: storeOp(op.m), data: ['create', 'insertOne', 'insertMany', 'save', 'insert', 'upsert', 'bulkCreate'].includes(op.m) ? shape(op.data) : undefined, confidence: 0.85 });
        return;
      }
      case 'prisma': {
        const { kind, obj } = this.kindOf(op.client);
        const ok = kind === 'prisma' || kind === 'inst-ext:@prisma/client.PrismaClient' || kind === 'ext:@prisma/client.PrismaClient#inst' || /prisma/i.test(JSON.stringify(op.client).slice(0, 300));
        void obj;
        if (!ok) return;
        push({ k: 'sink', db: this.sqlDialect(undefined, svcId, 'prisma'), name: op.model, op: storeOp(op.op), data: op.op.startsWith('create') || op.op === 'upsert' ? shape(member(op.data ?? { t: 'null' }, 'data')) : undefined, confidence: 0.85 });
        return;
      }
      case 'redis': {
        const { kind } = this.kindOf(op.recv);
        if (kind === 'map' || !(op.hinted || kind === 'redis' || kind.startsWith('ext:ioredis') || kind.startsWith('ext:redis'))) return;
        const key = strs(op.key)[0];
        if (!key) return;
        push({ k: 'sink', db: 'redis', name: key.replace(/\{[^}]*\}/g, (m) => m), op: op.cmd, meta: { pubsub: /SUBSCRIBE|PUBLISH/.test(op.cmd) || undefined }, confidence: kind === 'redis' ? 0.9 : 0.7 });
        return;
      }
      case 'es': {
        const idx = strs(op.index)[0];
        if (idx) push({ k: 'sink', db: 'elasticsearch', name: idx, op: op.op.toUpperCase(), data: shape(op.body), confidence: 0.85 });
        return;
      }
    }
  }

  private storeTarget(recv: Sym): { db: string; table: Sym } | undefined {
    const { kind, obj } = this.kindOf(recv);
    if (kind === 'model' && obj?.t === 'obj') return { db: (obj.fields.db as any)?.v ?? 'sql', table: obj.fields.table };
    if (kind === 'mongo-coll' && obj?.t === 'obj') return { db: 'mongo', table: obj.fields.name };
    if (kind === 'repo' && obj?.t === 'obj') {
      const ent = this.deref(obj.fields.entity);
      if (ent.t === 'class') return this.classTable(ent.id);
      if (ent.t === 'str') return { db: 'sql', table: ent };
    }
    if (kind === 'class' && obj?.t === 'class') return this.classTable(obj.id, true);
    return undefined;
  }

  classTable(classId: string, requireModel = false): { db: string; table: Sym } | undefined {
    const c = this.classes.get(classId);
    if (!c) return undefined;
    const ent = c.decorators.find((d) => d.name === 'Entity' || d.name === 'Table' || d.name === 'Schema');
    if (ent) {
      const a = ent.args[0] ? this.deref(ent.args[0]) : undefined;
      const nm = a?.t === 'str' ? a : a?.t === 'obj' ? a.fields.name ?? a.fields.tableName ?? a.fields.collection : undefined;
      if (ent.name === 'Schema') return { db: 'mongo', table: nm ?? { t: 'str', v: plural(c.name.toLowerCase()) } };
      return { db: 'sql', table: nm ?? { t: 'str', v: ent.name === 'Table' ? plural(c.name) : snake(c.name) } };
    }
    if (c.table) return { db: 'sql', table: c.table };
    const sup = this.superExt(classId);
    if (sup && /sequelize/.test(sup)) return { db: 'sql', table: { t: 'str', v: plural(c.name) } };
    if (requireModel) return undefined;
    return undefined;
  }

  sqlDialect(recv: Sym | undefined, svcId?: string, orm?: string): string {
    if (recv) {
      const { kind, obj } = this.kindOf(recv);
      if (kind === 'sql' && obj?.t === 'obj' && obj.fields.db?.t === 'str') return obj.fields.db.v;
    }
    const svc = this.services.find((s) => s.id === svcId);
    const d = svc?.deps ?? new Set<string>();
    if (d.has('pg') || d.has('postgres') || d.has('pg-promise') || d.has('@neondatabase/serverless')) return 'postgres';
    if (d.has('mysql') || d.has('mysql2')) return 'mysql';
    if (d.has('better-sqlite3') || d.has('sqlite3')) return 'sqlite';
    if (d.has('mssql') || d.has('tedious')) return 'mssql';
    if (d.has('oracledb')) return 'oracle';
    if (orm === 'prisma' && svc) {
      for (const f of ['prisma/schema.prisma', 'schema.prisma']) {
        try {
          const src = fs.readFileSync(path.join(svc.root, f), 'utf8');
          const m = src.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/);
          if (m) return m[1] === 'postgresql' ? 'postgres' : m[1];
        } catch {}
      }
      return 'sql';
    }
    return 'sql';
  }
}

// ------------------------------------------------------------ helpers
export function joinUrl(base: string, p: string): string {
  if (!base) return p;
  if (!p) return base;
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}

function storeOp(m: string): string {
  if (/^(find|count|exists|distinct|aggregate|max|min|sum|estimated|get|watch|createQueryBuilder)/i.test(m)) return 'SELECT';
  if (/^(create|insert|bulkCreate|save)/i.test(m)) return 'INSERT';
  if (/^(update|increment|decrement|replace|merge|preload|restore)/i.test(m) || /AndUpdate|AndReplace/.test(m)) return 'UPDATE';
  if (/^(delete|destroy|remove|softDelete)/i.test(m) || /AndDelete/.test(m)) return 'DELETE';
  if (/upsert|findOrCreate/i.test(m)) return 'UPSERT';
  return m.toUpperCase();
}

function snake(n: string) {
  return n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function shapeKeys(s: Sym): string[] | undefined {
  return s.t === 'obj' ? Object.keys(s.fields) : undefined;
}

let sqlParser: any;
async function loadSqlParser() {
  if (sqlParser !== undefined) return;
  try {
    const mod: any = await import('node-sql-parser');
    const P = mod.Parser ?? mod.default?.Parser;
    sqlParser = new P();
  } catch {
    sqlParser = null;
  }
}
await loadSqlParser();

/** Extract tables + operation from SQL text (node-sql-parser, with regex fallback). */
export function sqlTables(q: string): { table: string; op: string }[] {
  const text = q.replace(/\{[^}]*\}/g, '1').replace(/\$\d+/g, '1');
  const out = new Map<string, string>();
  if (sqlParser) {
    for (const database of ['PostgresQL', 'MySQL']) {
      try {
        const list: string[] = sqlParser.tableList(text, { database });
        for (const e of list) {
          const [op, , table] = e.split('::');
          if (table && table !== 'null' && !out.has(table.toLowerCase())) out.set(table.toLowerCase(), op.toUpperCase());
        }
        if (out.size) break;
      } catch {}
    }
  }
  if (!out.size) {
    const verb = (q.match(/^\s*(\w+)/)?.[1] ?? 'SELECT').toUpperCase();
    for (const m of q.matchAll(/\b(from|join|into|update|table)\s+([`"\w.]+)/gi)) {
      const t = m[2].replace(/[`"]/g, '').split('.').pop()!.toLowerCase();
      if (/^(select|set|where|values|\()$/.test(t)) continue;
      const op = /into/i.test(m[1]) ? 'INSERT' : /update/i.test(m[1]) ? 'UPDATE' : verb === 'DELETE' && /from/i.test(m[1]) ? 'DELETE' : 'SELECT';
      if (!out.has(t)) out.set(t, op);
    }
  }
  return [...out].map(([table, op]) => ({ table, op }));
}

export { mergeShapes };
export type { Evidence };
