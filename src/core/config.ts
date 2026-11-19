// Deployment/config knowledge gathered from compose, k8s, serverless/SAM, .env, terraform, nginx, SQL files.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import dotenv from 'dotenv';
import type { DiscoveredService } from './discover.ts';
import type { Warning } from './model.ts';

export interface LambdaFn {
  service?: string; // discovered service id
  name: string;
  handlerFile?: string; // absolute path w/o extension resolution
  handlerExport: string;
  events: ({ type: 'http'; method: string; path: string } | { type: 'sqs'; queue: string } | { type: 'sns'; topic: string } | { type: 'eventbridge'; source?: string; detailType?: string; bus?: string } | { type: 'schedule'; rate: string } | { type: 's3'; bucket: string })[];
  file: string;
}

export interface Proxy {
  ownerRoot?: string; // service root that owns the proxy (nginx inside a frontend)
  prefix: string;
  host: string;
  port?: number;
  targetPath?: string;
  file: string;
}

export interface Config {
  /** service id → env var → candidate values (highest priority first). */
  env: Map<string, Map<string, string[]>>;
  /** hostname alias (lowercase) → service id. */
  hosts: Map<string, string>;
  /** port → service ids. */
  ports: Map<number, Set<string>>;
  /** hostname → infra type, e.g. postgres, redis, elasticsearch (compose/k8s images). */
  infraHosts: Map<string, string>;
  lambdas: LambdaFn[];
  /** SNS topic name → SQS queue names subscribed (from IaC). */
  subscriptions: { topic: string; queue: string; file: string }[];
  /** logical id → physical name for CFN resources (queues/topics/tables/buckets). */
  logicalNames: Map<string, string>;
  /** table name → columns (from .sql / migrations). */
  tables: Map<string, { columns: string[]; file: string }>;
  proxies: Proxy[];
  warnings: Warning[];
}

const INFRA_IMAGES: [RegExp, string][] = [
  [/postgres|postgis|timescale/, 'postgres'],
  [/mysql|mariadb/, 'mysql'],
  [/mongo/, 'mongo'],
  [/redis|valkey|keydb/, 'redis'],
  [/elasticsearch|opensearch/, 'elasticsearch'],
  [/rabbitmq/, 'rabbitmq'],
  [/kafka|redpanda/, 'kafka'],
  [/localstack|elasticmq/, 'aws'],
  [/dynamodb/, 'dynamodb'],
  [/minio/, 's3'],
];

export function loadConfig(files: string[], services: DiscoveredService[]): Config {
  const cfg: Config = {
    env: new Map(),
    hosts: new Map(),
    ports: new Map(),
    infraHosts: new Map(),
    lambdas: [],
    subscriptions: [],
    logicalNames: new Map(),
    tables: new Map(),
    proxies: [],
    warnings: [],
  };
  for (const s of services) {
    for (const a of s.aliases) if (!cfg.hosts.has(a)) cfg.hosts.set(a, s.id);
  }
  const byRoot = (dir: string) => services.find((s) => s.root === dir) ?? services.find((s) => s.root.startsWith(dir + path.sep) && !services.some((o) => o !== s && o.root.startsWith(dir + path.sep)));
  const byName = (name: string | undefined) => {
    if (!name) return undefined;
    const n = name.toLowerCase().replace(/^.*\//, '').replace(/:.*$/, '');
    return services.find((s) => s.aliases.includes(n)) ?? services.find((s) => s.aliases.some((a) => n === a + '-deployment' || n === a + '-svc' || n === a + '-service' || n.startsWith(a + '-') && a.length > 3));
  };
  const addEnv = (svc: string | undefined, k: string, v: unknown, front = false) => {
    if (!svc || v === undefined || v === null) return;
    let m = cfg.env.get(svc);
    if (!m) cfg.env.set(svc, (m = new Map()));
    const list = m.get(k) ?? [];
    const sv = String(v);
    if (!list.includes(sv)) front ? list.unshift(sv) : list.push(sv);
    m.set(k, list);
  };
  const addPort = (svc: string | undefined, p: unknown) => {
    const n = Number(String(p).replace(/\/.*$/, ''));
    if (!svc || !Number.isFinite(n) || n <= 0) return;
    let set = cfg.ports.get(n);
    if (!set) cfg.ports.set(n, (set = new Set()));
    set.add(svc);
    const s = services.find((x) => x.id === svc);
    if (s && !s.ports.includes(n)) s.ports.push(n);
  };
  const addHost = (h: string | undefined, svc: string | undefined) => {
    if (h && svc && !cfg.hosts.has(h.toLowerCase())) cfg.hosts.set(h.toLowerCase(), svc);
  };

  const yamlFiles = files.filter((f) => /\.ya?ml$/.test(f));
  const k8sDocs: { doc: any; file: string }[] = [];
  for (const f of yamlFiles) {
    let docs: any[];
    try {
      docs = YAML.parseAllDocuments(fs.readFileSync(f, 'utf8'), { logLevel: 'silent', uniqueKeys: false } as any).map((d) => d.toJS({ maxAliasCount: 1000 }));
    } catch {
      continue;
    }
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      if (doc.services && typeof doc.services === 'object' && !doc.provider && Object.values(doc.services).some((s: any) => s && (s.image || s.build))) {
        compose(doc, f);
      } else if (doc.apiVersion && doc.kind) {
        k8sDocs.push({ doc, file: f });
      } else if (doc.provider && doc.functions) {
        serverless(doc, f);
      } else if (doc.Resources || doc.AWSTemplateFormatVersion || doc.Transform) {
        cloudformation(doc, f);
      }
    }
  }
  if (k8sDocs.length) k8s(k8sDocs);

  for (const f of files) {
    const base = path.basename(f);
    if (base.startsWith('.env')) {
      const svc = byRoot(path.dirname(f))?.id ?? services.find((s) => f.startsWith(s.root + path.sep))?.id;
      try {
        const parsed = dotenv.parse(fs.readFileSync(f));
        for (const [k, v] of Object.entries(parsed)) addEnv(svc, k, v);
      } catch {}
    } else if (f.endsWith('.sql')) {
      sqlTables(f);
    } else if (f.endsWith('.tf')) {
      terraform(f);
    }
  }
  // nginx confs are not in config glob list (no extension match) — look for them inside service roots
  for (const s of services) {
    for (const cand of ['nginx.conf', 'default.conf', 'nginx/default.conf', 'nginx/nginx.conf']) {
      const f = path.join(s.root, cand);
      if (fs.existsSync(f)) nginx(f, s.root);
    }
  }
  return cfg;

  // ---------------------------------------------------------------- compose
  function compose(doc: any, file: string) {
    const dir = path.dirname(file);
    for (const [name, def] of Object.entries<any>(doc.services)) {
      if (!def) continue;
      const ctx = typeof def.build === 'string' ? def.build : def.build?.context;
      let svc = ctx ? byRoot(path.resolve(dir, ctx))?.id : undefined;
      svc ??= byName(name)?.id ?? byName(def.container_name)?.id;
      const image = String(def.image ?? '');
      if (!svc) {
        const infra = INFRA_IMAGES.find(([re]) => re.test(image) || re.test(name));
        if (infra) {
          cfg.infraHosts.set(name.toLowerCase(), infra[1]);
          if (def.container_name) cfg.infraHosts.set(String(def.container_name).toLowerCase(), infra[1]);
        }
        continue;
      }
      addHost(name, svc);
      addHost(def.container_name, svc);
      addHost(def.hostname, svc);
      for (const n of Object.values<any>(def.networks ?? {})) for (const a of n?.aliases ?? []) addHost(a, svc);
      const env = def.environment;
      if (Array.isArray(env)) {
        for (const e of env) {
          const m = String(e).match(/^([^=]+)=(.*)$/);
          if (m) addEnv(svc, m[1], m[2], true);
        }
      } else if (env && typeof env === 'object') for (const [k, v] of Object.entries(env)) addEnv(svc, k, v, true);
      for (const ef of [def.env_file].flat().filter(Boolean)) {
        try {
          const p = typeof ef === 'string' ? ef : ef.path;
          for (const [k, v] of Object.entries(dotenv.parse(fs.readFileSync(path.resolve(dir, p))))) addEnv(svc, k, v, true);
        } catch {}
      }
      for (const p of def.ports ?? []) {
        const s = typeof p === 'object' ? `${p.published}:${p.target}` : String(p);
        const parts = s.split(':');
        addPort(svc, parts.at(-1));
        if (parts.length >= 2) addPort(svc, parts.at(-2));
      }
      for (const p of def.expose ?? []) addPort(svc, p);
    }
  }

  // ---------------------------------------------------------------- kubernetes
  function k8s(docs: { doc: any; file: string }[]) {
    const configMaps = new Map<string, Record<string, string>>();
    for (const { doc } of docs) if (doc.kind === 'ConfigMap' || doc.kind === 'Secret') configMaps.set(doc.metadata?.name, { ...(doc.data ?? {}), ...(doc.stringData ?? {}) });
    const podLabels: { labels: Record<string, string>; svc?: string; image: string; name: string }[] = [];
    for (const { doc } of docs) {
      const spec = doc.kind === 'CronJob' ? doc.spec?.jobTemplate?.spec?.template : doc.kind === 'Pod' ? doc : doc.spec?.template;
      const containers: any[] = spec?.spec?.containers ?? [];
      if (!containers.length) continue;
      for (const c of containers) {
        const svc = byName(c.name)?.id ?? byName(doc.metadata?.name)?.id ?? byName(String(c.image ?? '').split('/').pop())?.id;
        podLabels.push({ labels: spec?.metadata?.labels ?? {}, svc, image: String(c.image ?? ''), name: doc.metadata?.name });
        if (!svc) continue;
        for (const e of c.env ?? []) {
          if (e.value !== undefined) addEnv(svc, e.name, e.value, true);
          const ref = e.valueFrom?.configMapKeyRef ?? e.valueFrom?.secretKeyRef;
          if (ref) {
            const v = configMaps.get(ref.name)?.[ref.key];
            if (v !== undefined) addEnv(svc, e.name, v, true);
          }
        }
        for (const ef of c.envFrom ?? []) {
          const cm = configMaps.get(ef.configMapRef?.name ?? ef.secretRef?.name);
          for (const [k, v] of Object.entries(cm ?? {})) addEnv(svc, k, v, true);
        }
        for (const p of c.ports ?? []) addPort(svc, p.containerPort);
      }
    }
    for (const { doc } of docs) {
      if (doc.kind === 'Service') {
        const sel: Record<string, string> = doc.spec?.selector ?? {};
        const pod = podLabels.find((p) => Object.keys(sel).length && Object.entries(sel).every(([k, v]) => p.labels[k] === v));
        const name = String(doc.metadata?.name ?? '');
        const ns = doc.metadata?.namespace ?? 'default';
        const svc = pod?.svc ?? byName(name)?.id;
        const hosts = [name, `${name}.${ns}`, `${name}.${ns}.svc`, `${name}.${ns}.svc.cluster.local`];
        if (svc) {
          hosts.forEach((h) => addHost(h, svc));
          for (const p of doc.spec?.ports ?? []) addPort(svc, p.port);
        } else {
          const infra = INFRA_IMAGES.find(([re]) => re.test(pod?.image ?? '') || re.test(name));
          if (infra) hosts.forEach((h) => cfg.infraHosts.set(h.toLowerCase(), infra[1]));
        }
      } else if (doc.kind === 'Ingress') {
        for (const rule of doc.spec?.rules ?? []) {
          for (const p of rule.http?.paths ?? []) {
            const backend = p.backend?.service?.name ?? p.backend?.serviceName;
            const port = p.backend?.service?.port?.number ?? p.backend?.servicePort;
            if (backend) cfg.proxies.push({ prefix: String(p.path ?? '/').replace(/\(.*$/, ''), host: backend, port: Number(port) || undefined, file: '' });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- serverless framework
  function serverless(doc: any, file: string) {
    const dir = path.dirname(file);
    const svc = byRoot(dir) ?? services.find((s) => file.startsWith(s.root + path.sep));
    const interp = (v: any): any => {
      if (typeof v !== 'string') return v;
      return v.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
        const [ref, def] = expr.split(/,\s*/);
        if (ref.startsWith('self:')) {
          const val = ref.slice(5).split('.').reduce((o: any, k) => o?.[k], doc);
          if (val !== undefined && typeof val !== 'object') return interp(String(val));
        }
        if (ref.startsWith('env:')) return `{${ref.slice(4)}}`;
        if (def) return def.replace(/^['"]|['"]$/g, '');
        if (ref.startsWith('opt:stage') || ref.includes('stage')) return 'dev';
        return `{${ref}}`;
      });
    };
    if (doc.resources?.Resources) cloudformation({ Resources: doc.resources.Resources }, file, interp);
    for (const [k, v] of Object.entries<any>(doc.provider?.environment ?? {})) addEnv(svc?.id, k, refName(interp(v)));
    for (const [fname, fn] of Object.entries<any>(doc.functions ?? {})) {
      if (!fn) continue;
      for (const [k, v] of Object.entries<any>(fn.environment ?? {})) addEnv(svc?.id, k, refName(interp(v)));
      const handler = String(fn.handler ?? '');
      const m = handler.match(/^(.*)\.([^./]+)$/);
      const lf: LambdaFn = { service: svc?.id, name: interp(fn.name) ?? fname, handlerFile: m ? path.resolve(dir, m[1]) : undefined, handlerExport: m?.[2] ?? 'handler', events: [], file };
      for (const ev of fn.events ?? []) {
        const [type, conf] = Object.entries<any>(ev)[0] ?? [];
        if (type === 'http' || type === 'httpApi') {
          if (typeof conf === 'string') {
            const [method, p] = conf.split(/\s+/);
            lf.events.push({ type: 'http', method: method.toUpperCase(), path: p ?? '/' });
          } else lf.events.push({ type: 'http', method: String(conf?.method ?? 'ANY').toUpperCase(), path: '/' + String(conf?.path ?? '').replace(/^\//, '') });
        } else if (type === 'sqs') {
          lf.events.push({ type: 'sqs', queue: queueName(cfgName(refName(interp(typeof conf === 'string' ? conf : conf?.arn)))) });
        } else if (type === 'sns') {
          const t = typeof conf === 'string' ? conf : conf?.arn ?? conf?.topicName;
          lf.events.push({ type: 'sns', topic: arnName(cfgName(refName(interp(t)))) });
        } else if (type === 'eventBridge') {
          lf.events.push({ type: 'eventbridge', bus: interp(conf?.eventBus), source: conf?.pattern?.source?.[0], detailType: conf?.pattern?.['detail-type']?.[0] });
        } else if (type === 'schedule') {
          lf.events.push({ type: 'schedule', rate: String(typeof conf === 'string' ? conf : conf?.rate) });
        } else if (type === 's3') {
          lf.events.push({ type: 's3', bucket: interp(typeof conf === 'string' ? conf : conf?.bucket) });
        }
      }
      cfg.lambdas.push(lf);
    }
  }

  // ---------------------------------------------------------------- CloudFormation / SAM
  function cloudformation(doc: any, file: string, interp: (v: any) => any = (v) => v) {
    const res = doc.Resources ?? {};
    const dir = path.dirname(file);
    const svc = byRoot(dir) ?? services.find((s) => file.startsWith(s.root + path.sep));
    const physical = (logical: string) => {
      const r = res[logical];
      const p = r?.Properties ?? {};
      return interp(p.QueueName ?? p.TopicName ?? p.TableName ?? p.BucketName ?? p.FunctionName ?? logical);
    };
    for (const [logical, r] of Object.entries<any>(res)) {
      if (!r?.Type) continue;
      cfg.logicalNames.set(logical, String(physical(logical)));
    }
    for (const [logical, r] of Object.entries<any>(res)) {
      const p = r?.Properties ?? {};
      if (r?.Type === 'AWS::SNS::Subscription' && /sqs/i.test(String(p.Protocol))) {
        cfg.subscriptions.push({ topic: arnName(cfgName(refName(interp(p.TopicArn)))), queue: queueName(cfgName(refName(interp(p.Endpoint)))), file });
      } else if (r?.Type === 'AWS::SNS::Topic') {
        for (const sub of p.Subscription ?? []) if (/sqs/i.test(String(sub.Protocol))) cfg.subscriptions.push({ topic: String(physical(logical)), queue: queueName(cfgName(refName(interp(sub.Endpoint)))), file });
      } else if (r?.Type === 'AWS::Serverless::Function') {
        const handler = String(p.Handler ?? '');
        const m = handler.match(/^(.*)\.([^./]+)$/);
        const codeUri = typeof p.CodeUri === 'string' ? p.CodeUri : '.';
        const lf: LambdaFn = { service: svc?.id, name: p.FunctionName ?? logical, handlerFile: m ? path.resolve(dir, codeUri, m[1]) : undefined, handlerExport: m?.[2] ?? 'handler', events: [], file };
        for (const [k, v] of Object.entries<any>(p.Environment?.Variables ?? {})) addEnv(svc?.id, k, cfgName(refName(v)));
        for (const ev of Object.values<any>(p.Events ?? {})) {
          const ep = ev?.Properties ?? {};
          if (ev?.Type === 'Api' || ev?.Type === 'HttpApi') lf.events.push({ type: 'http', method: String(ep.Method ?? 'ANY').toUpperCase(), path: String(ep.Path ?? '/') });
          else if (ev?.Type === 'SQS') lf.events.push({ type: 'sqs', queue: queueName(cfgName(refName(ep.Queue))) });
          else if (ev?.Type === 'SNS') lf.events.push({ type: 'sns', topic: arnName(cfgName(refName(ep.Topic))) });
          else if (ev?.Type === 'EventBridgeRule' || ev?.Type === 'CloudWatchEvent') lf.events.push({ type: 'eventbridge', source: ep.Pattern?.source?.[0], detailType: ep.Pattern?.['detail-type']?.[0] });
        }
        cfg.lambdas.push(lf);
      }
    }
  }

  function cfgName(v: string) {
    return cfg.logicalNames.get(v) ?? v;
  }

  // ---------------------------------------------------------------- terraform (light regex parse)
  function terraform(file: string) {
    const src = fs.readFileSync(file, 'utf8');
    const block = /resource\s+"(aws_[a-z_]+)"\s+"([\w-]+)"\s*\{([\s\S]*?)\n\}/g;
    const names = new Map<string, string>();
    const blocks: [string, string, string][] = [];
    for (const m of src.matchAll(block)) {
      blocks.push([m[1], m[2], m[3]]);
      const nm = m[3].match(/\bname\s*=\s*"([^"]+)"/);
      names.set(`${m[1]}.${m[2]}`, nm ? nm[1] : m[2]);
    }
    for (const [type, , body] of blocks) {
      if (type !== 'aws_sns_topic_subscription' || !/protocol\s*=\s*"sqs"/.test(body)) continue;
      const t = body.match(/topic_arn\s*=\s*(aws_sns_topic\.[\w-]+)/);
      const q = body.match(/endpoint\s*=\s*(aws_sqs_queue\.[\w-]+)/);
      if (t && q) cfg.subscriptions.push({ topic: names.get(t[1]) ?? t[1], queue: names.get(q[1]) ?? q[1], file });
    }
  }

  // ---------------------------------------------------------------- SQL schema
  function sqlTables(file: string) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([`"\w.]+)\s*\(([\s\S]*?)\);/gi)) {
      const name = m[1].replace(/[`"]/g, '').split('.').pop()!.toLowerCase();
      const cols = m[2]
        .split(/,(?![^(]*\))/)
        .map((l) => l.trim().split(/\s+/)[0]?.replace(/[`"]/g, ''))
        .filter((c) => c && !/^(primary|foreign|unique|constraint|check|key|index)$/i.test(c));
      cfg.tables.set(name, { columns: cols, file });
    }
  }

  // ---------------------------------------------------------------- nginx proxies
  function nginx(file: string, ownerRoot: string) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/location\s+(?:[=~^]+\s*)?([^\s{]+)\s*\{([^}]*)\}/g)) {
      const pp = m[2].match(/proxy_pass\s+https?:\/\/([^:/;\s]+)(?::(\d+))?(\/[^;\s]*)?\s*;/);
      if (pp) cfg.proxies.push({ ownerRoot, prefix: m[1], host: pp[1], port: pp[2] ? Number(pp[2]) : undefined, targetPath: pp[3], file });
    }
  }
}

/** `{Ref: X}` / `{'Fn::GetAtt': [X, 'Arn']}` / `!GetAtt X.Arn` → X; otherwise string. */
export function refName(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\.(Arn|QueueUrl|QueueName|TopicName)$/, '');
  if (typeof v === 'object') {
    if (v.Ref) return String(v.Ref);
    const ga = v['Fn::GetAtt'];
    if (ga) return Array.isArray(ga) ? String(ga[0]) : String(ga).split('.')[0];
    const sub = v['Fn::Sub'];
    if (sub) return String(Array.isArray(sub) ? sub[0] : sub);
    const imp = v['Fn::ImportValue'];
    if (imp) return refName(imp);
  }
  return String(v);
}

/** Queue name from a URL / ARN / name. */
export function queueName(v: string): string {
  if (!v) return v;
  const s = String(v);
  if (/^https?:\/\//.test(s)) return s.replace(/\/+$/, '').split('/').pop()!;
  if (s.startsWith('arn:')) return s.split(':').pop()!;
  return s.replace(/^.*\//, '');
}

export function arnName(v: string): string {
  if (!v) return v;
  const s = String(v);
  if (s.startsWith('arn:')) return s.split(':').pop()!.split('/').pop()!;
  return s;
}
