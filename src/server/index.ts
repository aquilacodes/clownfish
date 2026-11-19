// Localhost-only HTTP API + viewer host.
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scan } from '../core/scan.ts';
import { serialize, parseMap } from '../core/emit.ts';
import type { ServiceMap } from '../core/model.ts';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Pre-load a map file (JSON or XML) as scan id "loaded". */
  mapFile?: string;
}

interface ScanJob {
  id: string;
  path: string;
  state: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  progress?: { phase: string; done?: number; total?: number; message?: string };
  error?: string;
  map?: ServiceMap;
}

const VIEWER_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../viewer/dist');

export function createApp(opts: ServerOptions = {}) {
  const jobs = new Map<string, ScanJob>();
  const app = express();
  app.disable('x-powered-by');

  if (opts.mapFile) {
    const map = parseMap(fs.readFileSync(opts.mapFile, 'utf8'));
    jobs.set('loaded', { id: 'loaded', path: map.root, state: 'done', startedAt: map.generatedAt, finishedAt: map.generatedAt, map });
  }

  // DNS-rebinding guard: the API reads local files, so only accept localhost Host headers.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['localhost', '127.0.0.1', '::1'].includes(host) && host !== opts.host) {
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '50mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: '0.1.0' });
  });

  app.get('/api/scans', (_req, res) => {
    res.json([...jobs.values()].map(summary));
  });

  app.post('/api/scans', (req, res) => {
    const body = (req.body ?? {}) as { path?: string; ignore?: string[]; includeTests?: boolean };
    const target = path.resolve(String(body.path ?? '').replace(/^~(?=$|\/)/, os.homedir()));
    if (!body.path || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      res.status(400).json({ error: `not a directory: ${body.path ?? ''}` });
      return;
    }
    const job: ScanJob = { id: randomUUID().slice(0, 8), path: target, state: 'running', startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    scan(target, { ignore: body.ignore, includeTests: body.includeTests, onProgress: (p) => (job.progress = p) })
      .then((map) => {
        job.map = map;
        job.state = 'done';
      })
      .catch((e) => {
        job.state = 'error';
        job.error = String(e?.stack ?? e);
      })
      .finally(() => (job.finishedAt = new Date().toISOString()));
    res.status(202).json(summary(job));
  });

  app.post('/api/maps', (req, res) => {
    try {
      const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const map = parseMap(text);
      const job: ScanJob = { id: randomUUID().slice(0, 8), path: map.root, state: 'done', startedAt: map.generatedAt, finishedAt: new Date().toISOString(), map };
      jobs.set(job.id, job);
      res.status(201).json(summary(job));
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  app.get('/api/scans/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'unknown scan' });
      return;
    }
    res.json(summary(job));
  });

  app.get('/api/scans/:id/map', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job?.map) {
      res.status(job ? 409 : 404).json({ error: job ? `scan is ${job.state}` : 'unknown scan' });
      return;
    }
    const format = req.query.format === 'xml' ? 'xml' : 'json';
    res.type(format === 'xml' ? 'application/xml' : 'application/json');
    if (req.query.download) res.attachment(`service-map.${format}`);
    res.send(serialize(job.map, format));
  });

  // Source context for evidence (only files inside a scanned root).
  app.get('/api/source', (req, res) => {
    const file = path.resolve(String(req.query.file ?? ''));
    const line = Math.max(1, Number(req.query.line ?? 1));
    const ctx = Math.min(40, Math.max(0, Number(req.query.context ?? 8)));
    const allowed = [...jobs.values()].some((j) => j.path && (file === j.path || file.startsWith(j.path + path.sep)));
    if (!allowed || !fs.existsSync(file)) {
      res.status(403).json({ error: 'file not inside a scanned root' });
      return;
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const from = Math.max(1, line - ctx);
    const to = Math.min(lines.length, line + ctx);
    res.json({ file, line, from, lines: lines.slice(from - 1, to) });
  });

  if (fs.existsSync(VIEWER_DIST)) {
    app.use(express.static(VIEWER_DIST, { index: 'index.html' }));
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('Viewer not built. Run `npm run build:viewer` in the clownfish repo, or use the API under /api.');
    });
  }

  return app;
}

function summary(j: ScanJob) {
  return { id: j.id, path: j.path, state: j.state, startedAt: j.startedAt, finishedAt: j.finishedAt, progress: j.progress, error: j.error, stats: j.map?.stats };
}

export function startServer(opts: ServerOptions = {}): Promise<{ url: string; close: () => void }> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7777;
  const app = createApp({ ...opts, host });
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${p}`, close: () => srv.close() });
    });
    srv.on('error', reject);
  });
}
