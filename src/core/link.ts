// URL parsing, route-pattern matching and host → service resolution.
import type { Config } from './config.ts';
import type { DiscoveredService } from './discover.ts';

export interface ParsedUrl {
  scheme?: string;
  host?: string; // undefined → relative; '{X}' → unresolved placeholder
  port?: number;
  path: string;
}

export function parseUrl(u: string): ParsedUrl {
  const s = u.trim();
  const m = s.match(/^(?:([a-z][a-z0-9+.-]*):)?\/\/([^/:?#]+)(?::([^/?#]+))?([^?#]*)?/i);
  if (m) {
    const port = Number(m[3]);
    return { scheme: m[1]?.toLowerCase(), host: m[2], port: Number.isFinite(port) ? port : undefined, path: normPath(m[4] || '/') };
  }
  // {API_URL}/orders  or {host}:{port}/x
  const ph = s.match(/^(\{[^}]+\})(?::(\d+))?(\/.*)?$/);
  if (ph) return { host: ph[1], port: ph[2] ? Number(ph[2]) : undefined, path: normPath(ph[3] || '/') };
  if (s.startsWith('/')) return { path: normPath(s) };
  if (/^[\w.-]+:\d+(\/|$)/.test(s)) {
    const [hp, ...rest] = s.split('/');
    const [h, p] = hp.split(':');
    return { host: h, port: Number(p), path: normPath('/' + rest.join('/')) };
  }
  return { path: normPath('/' + s) };
}

export function normPath(p: string): string {
  let out = p.split('?')[0].split('#')[0].replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out || '/';
}

export function segments(p: string): string[] {
  return normPath(p).split('/').filter(Boolean);
}

const isRouteParam = (s: string) => s.startsWith(':') || (s.startsWith('{') && s.endsWith('}')) || s === '*' || s.startsWith('(') || s.includes(':') || s === '**';
const isCallPlaceholder = (s: string) => /\{[^}]*\}/.test(s);

/** Score how well a concrete/placeholder call path matches a route pattern; -1 = no match. */
export function matchScore(route: string, call: string): number {
  const r = segments(route);
  const c = segments(call);
  const wildcardTail = r.length && (r[r.length - 1] === '*' || r[r.length - 1] === '**' || r[r.length - 1].endsWith('*') || r[r.length - 1] === '(.*)');
  if (r.length !== c.length && !(wildcardTail && c.length >= r.length - 1)) return -1;
  let score = 0;
  for (let i = 0; i < r.length; i++) {
    const rs = r[i];
    const cs = c[i];
    if (cs === undefined) return wildcardTail && i === r.length - 1 ? score : -1;
    if (rs === cs) score += 3;
    else if (isRouteParam(rs)) score += 1;
    else if (isCallPlaceholder(cs)) score += 0.5;
    else return -1;
  }
  return score;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '[::1]', '::1']);

export function serviceForHost(cfg: Config, host: string | undefined, port: number | undefined, self?: string): string | undefined {
  if (!host || host.startsWith('{')) return undefined;
  const h = host.toLowerCase();
  if (LOCAL.has(h)) {
    if (port === undefined) return undefined;
    const set = cfg.ports.get(port);
    if (!set?.size) return undefined;
    const list = [...set];
    return list.find((s) => s !== self) ?? list[0];
  }
  const direct = cfg.hosts.get(h) ?? cfg.hosts.get(h.split('.')[0]);
  return direct;
}

export function applyProxy(cfg: Config, caller: DiscoveredService | undefined, p: ParsedUrl): ParsedUrl | undefined {
  const cands = cfg.proxies
    .filter((x) => (!x.ownerRoot || x.ownerRoot === caller?.root) && (p.path === x.prefix.replace(/\/$/, '') || p.path.startsWith(x.prefix.endsWith('/') ? x.prefix : x.prefix + '/') || x.prefix === '/'))
    .sort((a, b) => (a.ownerRoot ? 0 : 1) - (b.ownerRoot ? 0 : 1) || b.prefix.length - a.prefix.length);
  const x = cands[0];
  if (!x || x.prefix === '/' && !x.ownerRoot && cands.length > 1) return cands[1] ? rewrite(cands[1], p) : undefined;
  return x ? rewrite(x, p) : undefined;
}

function rewrite(x: Config['proxies'][number], p: ParsedUrl): ParsedUrl {
  let path = p.path;
  if (x.targetPath !== undefined && x.targetPath !== '') {
    const rest = path.slice(x.prefix.replace(/\/$/, '').length);
    path = normPath(x.targetPath.replace(/\/$/, '') + '/' + rest.replace(/^\//, ''));
  }
  return { host: x.host, port: x.port, path };
}
