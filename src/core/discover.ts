// Find Node.js services/packages under a root folder and assign source files to them.
import fg from 'fast-glob';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ServiceInfo } from './model.ts';

export const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.vercel/**',
  '**/.serverless/**',
  '**/.aws-sam/**',
  '**/cdk.out/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/.Trash/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.d.ts',
];

const MAC_HOME_IGNORES = ['Library/**', 'Applications/**', 'Movies/**', 'Music/**', 'Pictures/**', '.Trash/**'];

const TEST_IGNORES = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**', '**/test/**', '**/tests/**', '**/e2e/**', '**/cypress/**', '**/*.stories.*'];
const CONFIG_FILE_IGNORES = ['**/*.config.{js,cjs,mjs,ts}', '**/.eslintrc.*', '**/Gruntfile.js', '**/gulpfile.js'];

const SERVER_DEPS: Record<string, string> = {
  express: 'express',
  koa: 'koa',
  '@koa/router': 'koa',
  'koa-router': 'koa',
  fastify: 'fastify',
  '@nestjs/core': 'nestjs',
  '@hapi/hapi': 'hapi',
  hapi: 'hapi',
  restify: 'restify',
  ws: 'ws',
  'socket.io': 'socket.io',
  'sqs-consumer': 'sqs-consumer',
  'aws-lambda': 'lambda',
  '@middy/core': 'lambda',
  'serverless-http': 'lambda',
  'apollo-server': 'graphql',
  '@apollo/server': 'graphql',
};
const FRONTEND_DEPS = ['react', 'vue', '@angular/core', 'svelte', 'next', 'nuxt', 'vite', 'preact', 'solid-js'];

export interface DiscoveredService extends ServiceInfo {
  pkg: Record<string, any>;
  files: string[];
  deps: Set<string>;
}

export interface Discovery {
  root: string;
  services: DiscoveredService[];
  /** yaml/json/env/sql/tf config files found anywhere under root. */
  configFiles: string[];
  ignores: string[];
}

export interface DiscoverOptions {
  ignore?: string[];
  includeTests?: boolean;
}

export async function discover(rootIn: string, opts: DiscoverOptions = {}): Promise<Discovery> {
  const root = path.resolve(rootIn.replace(/^~(?=$|\/)/, os.homedir()));
  const ignores = [...DEFAULT_IGNORES, ...(opts.ignore ?? []), ...readIgnoreFile(root)];
  if (root === os.homedir()) ignores.push(...MAC_HOME_IGNORES);

  const globOpts = { cwd: root, absolute: true, ignore: ignores, followSymbolicLinks: false, suppressErrors: true, dot: false } as const;

  const pkgFiles = await fg('**/package.json', globOpts);
  const pkgs = pkgFiles
    .map((f) => ({ dir: path.dirname(f), pkg: readJson(f) }))
    .filter((p): p is { dir: string; pkg: Record<string, any> } => !!p.pkg)
    .sort((a, b) => b.dir.length - a.dir.length); // deepest first for ownership

  const srcIgnores = [...ignores, ...CONFIG_FILE_IGNORES, ...(opts.includeTests ? [] : TEST_IGNORES)];
  const srcFiles = await fg('**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}', { ...globOpts, ignore: srcIgnores });

  const byDir = new Map<string, string[]>();
  for (const f of srcFiles) {
    const owner = pkgs.find((p) => f.startsWith(p.dir + path.sep));
    if (!owner) continue;
    let list = byDir.get(owner.dir);
    if (!list) byDir.set(owner.dir, (list = []));
    list.push(f);
  }

  const services: DiscoveredService[] = [];
  const usedNames = new Map<string, number>();
  for (const { dir, pkg } of pkgs) {
    const files = byDir.get(dir) ?? [];
    if (!files.length) continue;
    const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    const frameworks = [...new Set([...deps].map((d) => SERVER_DEPS[d]).filter(Boolean))];
    const hasServerless = fs.existsSync(path.join(dir, 'serverless.yml')) || fs.existsSync(path.join(dir, 'serverless.yaml')) || fs.existsSync(path.join(dir, 'template.yaml'));
    if (hasServerless && !frameworks.includes('lambda')) frameworks.push('lambda');
    const isFrontend = FRONTEND_DEPS.some((d) => deps.has(d)) && !frameworks.some((f) => f !== 'ws');
    const hasStart = !!(pkg.scripts?.start || pkg.scripts?.dev || pkg.scripts?.serve);
    const kind: ServiceInfo['kind'] = frameworks.includes('lambda') && frameworks.length === 1 ? 'lambda' : frameworks.length ? 'service' : isFrontend ? 'frontend' : hasStart ? 'service' : 'library';
    if (pkg.workspaces && kind === 'library') continue; // monorepo root w/o own code of interest

    let name: string = pkg.name || path.basename(dir);
    const n = usedNames.get(name) ?? 0;
    usedNames.set(name, n + 1);
    if (n > 0) name = `${name}~${path.relative(root, dir) || '.'}`;

    const tsCount = files.filter((f) => /\.(m|c)?tsx?$/.test(f)).length;
    const short = name.replace(/^@[^/]+\//, '');
    services.push({
      id: name,
      name,
      root: dir,
      kind,
      frameworks: frameworks.length ? frameworks : isFrontend ? ['frontend'] : [],
      language: tsCount === 0 ? 'js' : tsCount === files.length ? 'ts' : 'mixed',
      aliases: [...new Set([name, short, path.basename(dir)].map((s) => s.toLowerCase()))],
      ports: [],
      pkg,
      files,
      deps,
    });
  }

  const configFiles = await fg('**/*.{yml,yaml,env,sql,tf,json}', {
    ...globOpts,
    dot: true,
    ignore: [...ignores, '**/package.json', '**/package-lock.json', '**/tsconfig*.json', '**/*.lock', '**/.vscode/**', '**/.idea/**'],
  });
  const dotenv = await fg('**/.env*', { ...globOpts, dot: true });
  const cfg = [...configFiles, ...dotenv].filter((f) => {
    try {
      return fs.statSync(f).size < 2_000_000;
    } catch {
      return false;
    }
  });

  return { root, services: services.sort((a, b) => a.name.localeCompare(b.name)), configFiles: [...new Set(cfg)], ignores };
}

function readJson(f: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
}

function readIgnoreFile(root: string): string[] {
  try {
    return fs
      .readFileSync(path.join(root, '.clownfishignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}
