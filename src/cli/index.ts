// clownfish CLI: scan | serve | view
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { scan } from '../core/scan.ts';
import { serialize, type Format } from '../core/emit.ts';
import { startServer } from '../server/index.ts';

const program = new Command();
program.name('clownfish').description('Map service-to-service calls across a folder of Node.js services').version('0.1.0');

program
  .command('scan')
  .description('scan a folder and write the service map as JSON or XML')
  .argument('<dir>', 'folder to scan (e.g. ~/code)')
  .option('-o, --out <file>', 'output file (default: stdout)')
  .option('-f, --format <format>', 'json | xml (default: from --out extension, else json)')
  .option('-i, --ignore <glob...>', 'extra glob patterns to ignore')
  .option('--include-tests', 'also analyze test/spec files', false)
  .option('--no-external-clients', 'do not add the implicit "External clients" entry node')
  .option('-w, --workers <n>', 'parser worker threads (0 = in-process)', (v) => Number(v))
  .option('-q, --quiet', 'no progress output', false)
  .action(async (dir: string, o) => {
    const format: Format = o.format === 'xml' || (!o.format && o.out?.endsWith('.xml')) ? 'xml' : 'json';
    const tty = process.stderr.isTTY;
    const map = await scan(dir, {
      ignore: o.ignore,
      includeTests: o.includeTests,
      externalClients: o.externalClients,
      workers: o.workers,
      onProgress: (p) => {
        if (o.quiet) return;
        const line = `[clownfish] ${p.phase}${p.total ? ` ${p.done}/${p.total}` : ''}${p.message ? ` – ${p.message}` : ''}`;
        if (tty && p.phase === 'analyze') process.stderr.write(`\r${line}   `);
        else process.stderr.write((tty ? '\n' : '') + line + '\n');
      },
    });
    const text = serialize(map, format);
    if (o.out) {
      fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
      fs.writeFileSync(o.out, text);
    } else process.stdout.write(text);
    if (!o.quiet) {
      const s = map.stats;
      process.stderr.write(`[clownfish] ${s.services} packages · ${s.files} files · ${s.nodes} nodes · ${s.edges} edges · ${s.flows} flows · ${map.warnings.length} warnings · ${s.durationMs}ms${o.out ? ` → ${o.out}` : ''}\n`);
    }
  });

program
  .command('serve')
  .description('start the local API + viewer (binds to 127.0.0.1)')
  .option('-p, --port <port>', 'port', (v) => Number(v), 7777)
  .option('--host <host>', 'bind address', '127.0.0.1')
  .option('-m, --map <file>', 'pre-load a map file (JSON or XML)')
  .option('--open', 'open the viewer in a browser', false)
  .action(async (o) => {
    const { url } = await startServer({ port: o.port, host: o.host, mapFile: o.map });
    const viewUrl = o.map ? `${url}/?scan=loaded` : url;
    process.stderr.write(`[clownfish] viewer + API on ${viewUrl}\n`);
    if (o.open) openBrowser(viewUrl);
  });

program
  .command('view')
  .description('open a map file (JSON or XML) in the viewer')
  .argument('<map>', 'map file')
  .option('-p, --port <port>', 'port', (v) => Number(v), 7777)
  .action(async (file: string, o) => {
    const { url } = await startServer({ port: o.port, mapFile: file });
    const viewUrl = `${url}/?scan=loaded`;
    process.stderr.write(`[clownfish] viewing ${file} on ${viewUrl}\n`);
    openBrowser(viewUrl);
  });

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`[clownfish] ${e?.stack ?? e}\n`);
  process.exit(1);
});
