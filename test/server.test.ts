import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/shop');

test('API: scan a folder, fetch JSON and XML, guard hosts and source paths', async () => {
  const srv = await startServer({ port: 0 });
  try {
    const started = await (await fetch(`${srv.url}/api/scans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }) })).json();
    assert.equal(started.state, 'running');
    let s = started;
    for (let i = 0; i < 100 && s.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = await (await fetch(`${srv.url}/api/scans/${started.id}`)).json();
    }
    assert.equal(s.state, 'done');
    const map = await (await fetch(`${srv.url}/api/scans/${started.id}/map`)).json();
    assert.ok(map.edges.length > 30);
    const xml = await (await fetch(`${srv.url}/api/scans/${started.id}/map?format=xml`)).text();
    assert.ok(xml.startsWith('<?xml') && xml.includes('<serviceMap'));
    const bad = await fetch(`${srv.url}/api/scans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/definitely/not/here' }) });
    assert.equal(bad.status, 400);
    const outside = await fetch(`${srv.url}/api/source?file=/etc/hostname&line=1`);
    assert.equal(outside.status, 403);
    const inside = await (await fetch(`${srv.url}/api/source?file=${encodeURIComponent(path.join(root, 'services/gateway/src/index.ts'))}&line=3&context=1`)).json();
    assert.equal(inside.lines.length, 3);
  } finally {
    srv.close();
  }
});
