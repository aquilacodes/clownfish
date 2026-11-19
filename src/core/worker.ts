import { parentPort } from 'node:worker_threads';
import { analyzeOne } from './pool.ts';

parentPort!.on('message', (files: string[]) => {
  const res = [];
  for (const f of files) {
    const r = analyzeOne(f);
    if (r) res.push(r);
  }
  parentPort!.postMessage(res);
});
