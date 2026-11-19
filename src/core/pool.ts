// Parse/analyze files on a worker-thread pool (falls back to in-process for small inputs).
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { analyzeFile, emptyFacts, type FileFacts } from './analyze.ts';

const MAX_BYTES = 1_500_000; // skip giant generated bundles

export function analyzeOne(file: string): FileFacts | undefined {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return undefined;
    return analyzeFile(file, fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    return emptyFacts(file, `${String(e?.message ?? e)}`.slice(0, 300));
  }
}

export async function analyzeParallel(files: string[], workers?: number, onDone?: (n: number) => void): Promise<FileFacts[]> {
  const n = Math.max(0, Math.min(workers ?? Math.min(8, os.cpus().length - 1), Math.ceil(files.length / 40)));
  const out: FileFacts[] = [];
  if (n <= 1) {
    let i = 0;
    for (const f of files) {
      const r = analyzeOne(f);
      if (r) out.push(r);
      if (++i % 50 === 0) onDone?.(i);
    }
    onDone?.(files.length);
    return out;
  }
  let next = 0;
  let done = 0;
  const batch = 25;
  await Promise.all(
    Array.from({ length: n }, () =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL('./worker.ts', import.meta.url));
        const feed = () => {
          if (next >= files.length) {
            w.terminate().then(() => resolve());
            return;
          }
          const chunk = files.slice(next, next + batch);
          next += batch;
          w.postMessage(chunk);
        };
        w.on('message', (res: FileFacts[]) => {
          out.push(...res);
          done += res.length;
          onDone?.(done);
          feed();
        });
        w.on('error', reject);
        feed();
      }),
    ),
  );
  return out;
}
