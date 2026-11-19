// Symbolic values: a small expression language recorded during per-file analysis
// and resolved later (once env config, cross-file exports and call-site arguments are known).
import type { Shape } from './model.ts';

export type Sym =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool' }
  | { t: 'null' }
  | { t: 'env'; name: string; fallback?: Sym }
  | { t: 'concat'; parts: Sym[] }
  | { t: 'alt'; opts: Sym[] }
  | { t: 'param'; fn: string; i: number; path?: string[]; name?: string }
  /** The return value of calling `fn` with `args` (resolved lazily, e.g. factory functions). */
  | { t: 'ret'; fn: Sym; args: (Sym | undefined)[]; path?: string[] }
  | { t: 'ref'; file: string; source: string; imported: string; path?: string[] }
  | { t: 'obj'; fields: Record<string, Sym>; spread?: Sym[] }
  | { t: 'arr'; item?: Sym }
  | { t: 'json'; of: Sym }
  | { t: 'shape'; shape: Shape }
  | { t: 'type'; name: string; file: string; array?: boolean }
  | { t: 'dyn'; hint: string }
  /** A function by id (file#name). */
  | { t: 'fn'; id: string }
  /** A class by id. */
  | { t: 'class'; id: string }
  /** An instance of a class (or of something resolving to a class), with pending member path. */
  | { t: 'inst'; cls: Sym; path?: string[] }
  /** Something exported by an external (node_modules) package. */
  | { t: 'ext'; mod: string; path: string[] };

export const S = {
  str: (v: string): Sym => ({ t: 'str', v }),
  dyn: (hint: string): Sym => ({ t: 'dyn', hint: hint.replace(/[^\w.$-]/g, '').slice(0, 40) || 'x' }),
};

/** Member access on a symbolic value. */
export function member(s: Sym, key: string): Sym {
  switch (s.t) {
    case 'obj':
      if (key in s.fields) return s.fields[key];
      return { t: 'dyn', hint: key };
    case 'param':
      return { ...s, path: [...(s.path ?? []), key] };
    case 'ref':
      return { ...s, path: [...(s.path ?? []), key] };
    case 'shape': {
      const f = s.shape.fields?.[key];
      return f ? { t: 'shape', shape: f } : { t: 'dyn', hint: key };
    }
    case 'arr':
      return s.item ?? { t: 'dyn', hint: key };
    case 'inst':
    case 'ret':
      return { ...s, path: [...(s.path ?? []), key] };
    case 'ext':
      return { ...s, path: [...s.path, key] };
    case 'class':
      return { t: 'fn', id: `${s.id}.${key}` };
    default:
      return { t: 'dyn', hint: key };
  }
}

/** Hooks used by the resolver to look up values that live outside the expression. */
export interface ResolveCtx {
  env: (name: string) => string[] | undefined;
  /** Dereference a ref / inst-with-path to its underlying value (undefined if unresolvable). */
  ref: (s: Sym) => Sym | undefined;
  /** Resolve a TS type name to a shape. */
  type: (name: string, file: string) => Shape | undefined;
  /** Declared shape of a function parameter (TS annotation), if known. */
  param?: (fn: string, i: number) => Shape | undefined;
  depth?: number;
}

const MAX_CANDS = 8;

/** Expand a symbolic value into candidate strings. Unknown parts become `{hint}` placeholders. */
export function strings(s: Sym | undefined, ctx: ResolveCtx, depth = 0): string[] {
  if (!s) return [];
  if (depth > 25) return ['{?}'];
  switch (s.t) {
    case 'str':
      return [s.v];
    case 'num':
      return [String(s.v)];
    case 'bool':
      return ['{bool}'];
    case 'null':
      return [];
    case 'env': {
      const vals = ctx.env(s.name);
      const fb = s.fallback ? strings(s.fallback, ctx, depth + 1) : [];
      const out = [...(vals ?? []), ...fb];
      return out.length ? uniq(out).slice(0, MAX_CANDS) : [`{${s.name}}`];
    }
    case 'concat': {
      let acc: string[] = [''];
      for (const p of s.parts) {
        let ps = strings(p, ctx, depth + 1);
        if (!ps.length) ps = [''];
        const next: string[] = [];
        for (const a of acc) for (const b of ps) next.push(a + b);
        acc = uniq(next).slice(0, MAX_CANDS);
      }
      return acc;
    }
    case 'alt':
      return uniq(s.opts.flatMap((o) => strings(o, ctx, depth + 1))).slice(0, MAX_CANDS);
    case 'ref':
    case 'ret':
    case 'inst': {
      const r = ctx.ref(s);
      if (r && r !== s) return strings(r, ctx, depth + 1);
      if (s.t === 'ret') return [`{${s.path?.at(-1) ?? 'value'}}`];
      return [`{${s.path?.at(-1) ?? (s.t === 'ref' ? s.imported : 'x')}}`];
    }
    case 'ext':
      return [`{${s.path.at(-1) ?? s.mod}}`];
    case 'param':
      return [`{${s.path?.at(-1) ?? s.name ?? 'arg' + s.i}}`];
    case 'dyn':
      return [`{${s.hint}}`];
    default:
      return ['{?}'];
  }
}

/** Best single string (first candidate). */
export function str1(s: Sym | undefined, ctx: ResolveCtx): string | undefined {
  return strings(s, ctx)[0];
}

/** Derive a structural shape from a symbolic value. */
export function shapeOf(s: Sym | undefined, ctx: ResolveCtx, depth = 0): Shape | undefined {
  if (!s) return undefined;
  if (depth > 12) return { type: 'unknown' };
  switch (s.t) {
    case 'str':
    case 'concat':
      return { type: 'string', source: 'literal' };
    case 'num':
      return { type: 'number', source: 'literal' };
    case 'bool':
      return { type: 'boolean', source: 'literal' };
    case 'null':
      return { type: 'null' };
    case 'env':
      return { type: 'string' };
    case 'json':
      return shapeOf(s.of, ctx, depth + 1);
    case 'obj': {
      const fields: Record<string, Shape> = {};
      for (const sp of s.spread ?? []) {
        const sh = shapeOf(sp, ctx, depth + 1);
        if (sh?.fields) Object.assign(fields, sh.fields);
      }
      for (const [k, v] of Object.entries(s.fields)) fields[k] = shapeOf(v, ctx, depth + 1) ?? { type: 'unknown' };
      return { type: 'object', fields, source: 'literal' };
    }
    case 'arr':
      return { type: 'array', items: shapeOf(s.item, ctx, depth + 1) ?? { type: 'unknown' } };
    case 'shape':
      return s.shape;
    case 'type': {
      const sh = ctx.type(s.name, s.file);
      const base = sh ?? { type: 'object', typeName: s.name, source: 'ts' };
      return s.array ? { type: 'array', items: base } : base;
    }
    case 'ref':
    case 'ret':
    case 'inst': {
      const r = ctx.ref(s);
      return r && r !== s ? shapeOf(r, ctx, depth + 1) : { type: 'unknown' };
    }
    case 'param': {
      let sh = ctx.param?.(s.fn, s.i);
      for (const k of s.path ?? []) sh = sh?.fields?.[k];
      return sh ?? { type: 'unknown' };
    }
    case 'alt': {
      for (const o of s.opts) {
        const sh = shapeOf(o, ctx, depth + 1);
        if (sh && sh.type !== 'unknown') return sh;
      }
      return { type: 'unknown' };
    }
    default:
      return { type: 'unknown' };
  }
}

/** Substitute parameters of `fn` with the given argument values (call-site instantiation). */
export function subst(s: Sym, fn: string, args: (Sym | undefined)[], depth = 0): Sym {
  if (depth > 30) return s;
  switch (s.t) {
    case 'param': {
      if (s.fn !== fn) return s;
      const a = args[s.i];
      if (!a) return { t: 'dyn', hint: s.path?.at(-1) ?? `arg${s.i}` };
      let out = a;
      for (const k of s.path ?? []) out = member(out, k);
      return out;
    }
    case 'concat':
      return { t: 'concat', parts: s.parts.map((p) => subst(p, fn, args, depth + 1)) };
    case 'alt':
      return { t: 'alt', opts: s.opts.map((p) => subst(p, fn, args, depth + 1)) };
    case 'obj': {
      const fields: Record<string, Sym> = {};
      for (const [k, v] of Object.entries(s.fields)) fields[k] = subst(v, fn, args, depth + 1);
      return { t: 'obj', fields, spread: s.spread?.map((p) => subst(p, fn, args, depth + 1)) };
    }
    case 'arr':
      return s.item ? { t: 'arr', item: subst(s.item, fn, args, depth + 1) } : s;
    case 'json':
      return { t: 'json', of: subst(s.of, fn, args, depth + 1) };
    case 'env':
      return s.fallback ? { ...s, fallback: subst(s.fallback, fn, args, depth + 1) } : s;
    case 'inst':
      return { ...s, cls: subst(s.cls, fn, args, depth + 1) };
    case 'ret':
      return { ...s, fn: subst(s.fn, fn, args, depth + 1), args: s.args.map((a) => (a ? subst(a, fn, args, depth + 1) : a)) };
    default:
      return s;
  }
}

/** Generic deep-substitute over any record containing Syms (ops). */
export function substAny<T>(v: T, fn: string, args: (Sym | undefined)[]): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => substAny(x, fn, args)) as T;
  const o = v as Record<string, unknown>;
  if (typeof o.t === 'string' && isSymTag(o.t)) return subst(o as unknown as Sym, fn, args) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = k === 'loc' ? x : substAny(x, fn, args);
  return out as T;
}

const SYM_TAGS = new Set(['str', 'num', 'bool', 'null', 'env', 'concat', 'alt', 'param', 'ref', 'obj', 'arr', 'json', 'shape', 'type', 'dyn', 'fn', 'class', 'inst', 'ext', 'ret']);
function isSymTag(t: string) {
  return SYM_TAGS.has(t);
}

export function isParamOf(s: Sym | undefined, fn: string, i: number): boolean {
  return !!s && s.t === 'param' && s.fn === fn && s.i === i && !s.path?.length;
}

export function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

export function mergeShapes(a: Shape | undefined, b: Shape | undefined): Shape | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.type === 'unknown') return b;
  if (b.type === 'unknown') return a;
  if (a.type === 'object' && b.type === 'object') {
    const fields: Record<string, Shape> = { ...(a.fields ?? {}) };
    for (const [k, v] of Object.entries(b.fields ?? {})) fields[k] = mergeShapes(fields[k], v) ?? v;
    return { ...a, ...b, fields, typeName: a.typeName ?? b.typeName };
  }
  return a;
}
