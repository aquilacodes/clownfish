// Per-file static analysis: one Babel pass that records functions, call sites, exports,
// classes, routes, consumers and "operations" (outbound calls / datastore access) as symbolic facts.
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type { Shape } from './model.ts';
import { member, type Sym } from './sym.ts';
import { tsTypeToShape, schemaShape } from './shapes.ts';

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

export interface Loc {
  file: string;
  line: number;
  col: number;
  snippet?: string;
}

export interface CallSite {
  target: Sym;
  args: (Sym | undefined)[];
  loc: Loc;
  callback?: boolean;
}

export type Op = (
  | { k: 'http'; lib: string; method: Sym; url: Sym; base?: Sym; body?: Sym; resType?: Sym; recv?: Sym; guard: 'none' | 'client' }
  | { k: 'ws-connect'; lib: string; url: Sym }
  | { k: 'ws-emit'; recv: Sym; event: Sym; payload?: Sym }
  | { k: 'aws'; svc: 'sqs' | 'sns' | 'eventbridge' | 'lambda' | 's3' | 'dynamodb'; action: string; input: Sym; v3: boolean }
  | { k: 'sql'; sql: Sym; recv?: Sym }
  | { k: 'knex'; recv: Sym; table: Sym; op: string }
  | { k: 'store'; recv: Sym; m: string; data?: Sym }
  | { k: 'prisma'; client: Sym; model: string; op: string; data?: Sym }
  | { k: 'redis'; recv: Sym; cmd: string; key: Sym; hinted: boolean }
  | { k: 'es'; index: Sym; op: string; body?: Sym }
  | { k: 'respond'; res: Sym; status?: number; body?: Sym; style: 'express' | 'koa' }
  | { k: 'reads'; sym: Sym }
  | { k: 'validate'; target: Sym; schema: Sym }
) & { loc: Loc };

export interface FnFacts {
  id: string;
  name: string;
  file: string;
  params: string[];
  paramTypes: (Sym | undefined)[];
  /** Nest-style param decorators: index → decorator name (Body, Param, Query, Req, Res...). */
  paramDecorators: Record<number, string>;
  calls: CallSite[];
  ops: Op[];
  returns: Sym[];
  loc: Loc;
  className?: string;
  decorators: { name: string; args: (Sym | undefined)[] }[];
}

export interface ClassFacts {
  id: string;
  name: string;
  file: string;
  fields: Record<string, Sym>;
  methods: string[];
  decorators: { name: string; args: (Sym | undefined)[] }[];
  superClass?: Sym;
  /** Sequelize Model.init(…, { tableName }) */
  table?: Sym;
  loc: Loc;
}

export interface RouteFacts {
  recv?: Sym;
  method: string;
  path: Sym;
  handlers: Sym[];
  style: 'express' | 'koa' | 'fastify' | 'hapi' | 'nest';
  /** Route certainly is a route (receiver known to be a router/app, or decorator based). */
  certain: boolean;
  /** For ambiguous `x.post('/p', y)` calls: index of the competing http op in the owning fn. */
  loc: Loc;
  fn: string; // enclosing function id
  nestBody?: { index: number; type?: Sym };
}

export interface MountFacts {
  via: 'use' | 'register';
  parent: Sym;
  prefix?: Sym;
  child: Sym;
  loc: Loc;
}

export type ConsumerFacts = (
  | { k: 'sqs'; queue: Sym; handler: Sym }
  | { k: 'ws-server'; id: string; path?: Sym; port?: Sym }
  | { k: 'ws-connection'; recv: Sym; handler: Sym }
  | { k: 'sio-event'; event: string; handler: Sym }
) & { loc: Loc; fn: string };

export interface FileFacts {
  file: string;
  exports: Map<string, Sym>;
  stars: string[];
  imports: Map<string, { source: string; imported: string }>;
  fns: Map<string, FnFacts>;
  classes: Map<string, ClassFacts>;
  routes: RouteFacts[];
  mounts: MountFacts[];
  consumers: ConsumerFacts[];
  listens: { recv: Sym; port: Sym; loc: Loc }[];
  globalPrefixes: Sym[];
  /** Functions registered as handlers (not to be treated as orphan entry roots). */
  handlerRefs: Sym[];
  types: Map<string, Shape>;
  moduleFn: string;
  error?: string;
}

// ------------------------------------------------------------------ tables

export const KNOWN_MODS = new Set([
  'axios', 'got', 'node-fetch', 'undici', 'superagent', 'ky', 'ofetch', 'needle', 'request', 'cross-fetch', 'isomorphic-fetch',
  'http', 'https', 'ws', 'socket.io', 'socket.io-client', 'express', 'koa', '@koa/router', 'koa-router', 'fastify', '@hapi/hapi', 'hapi', 'restify',
  'ioredis', 'redis', 'pg', 'pg-promise', 'postgres', 'mysql', 'mysql2', 'mysql2/promise', 'knex', 'sequelize', 'sequelize-typescript', 'mongoose', 'mongodb', '@prisma/client',
  'typeorm', '@nestjs/common', '@nestjs/typeorm', '@nestjs/mongoose', '@nestjs/sequelize', 'aws-sdk', 'sqs-consumer', '@elastic/elasticsearch', 'elasticsearch', '@opensearch-project/opensearch',
  'zod', 'joi', '@hapi/joi', 'yup', 'better-sqlite3', 'sqlite3', 'mssql', 'serverless-http',
]);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'options', 'head']);
const SQL_METHODS = new Set(['query', 'execute', 'none', 'one', 'many', 'any', 'oneOrNone', 'manyOrNone', 'result', 'raw', '$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', 'all', 'run', 'exec', 'prepare', 'unsafe']);
export const STORE_METHODS = new Set([
  'find', 'findAll', 'findOne', 'findByPk', 'findById', 'findOrCreate', 'findAndCountAll', 'findOneBy', 'findBy', 'findOneOrFail', 'findAndCount',
  'create', 'bulkCreate', 'update', 'updateOne', 'updateMany', 'destroy', 'upsert', 'count', 'countDocuments', 'deleteOne', 'deleteMany', 'insertOne', 'insertMany',
  'aggregate', 'findOneAndUpdate', 'findByIdAndUpdate', 'findByIdAndDelete', 'findOneAndDelete', 'findOneAndReplace', 'exists', 'distinct', 'replaceOne', 'save', 'insert', 'delete', 'remove',
  'increment', 'decrement', 'bulkWrite', 'createQueryBuilder', 'merge', 'preload', 'softDelete', 'restore', 'max', 'min', 'sum', 'estimatedDocumentCount', 'watch',
]);
const PRISMA_METHODS = new Set(['findMany', 'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow', 'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy']);
export const REDIS_CMDS = new Set([
  'get', 'set', 'setex', 'setnx', 'psetex', 'getset', 'getdel', 'getex', 'mget', 'mset', 'del', 'unlink', 'exists', 'expire', 'pexpire', 'expireat', 'ttl', 'pttl', 'persist', 'incr', 'incrby', 'decr', 'decrby', 'incrbyfloat', 'append',
  'hget', 'hset', 'hsetnx', 'hmget', 'hmset', 'hgetall', 'hdel', 'hexists', 'hincrby', 'hkeys', 'hvals', 'hlen',
  'lpush', 'rpush', 'lpop', 'rpop', 'lrange', 'llen', 'lrem', 'lindex', 'lset', 'ltrim', 'blpop', 'brpop',
  'sadd', 'srem', 'smembers', 'sismember', 'scard', 'spop', 'srandmember',
  'zadd', 'zrem', 'zrange', 'zrevrange', 'zrangebyscore', 'zscore', 'zincrby', 'zcard', 'zrank', 'zcount',
  'publish', 'subscribe', 'psubscribe', 'xadd', 'xread', 'xreadgroup', 'xgroup', 'xack', 'pfadd', 'pfcount', 'setbit', 'getbit', 'keys', 'scan', 'sscan', 'hscan', 'zscan', 'watch',
  'json.get', 'json.set',
]);
const ES_METHODS = new Set(['index', 'search', 'get', 'update', 'delete', 'bulk', 'count', 'create', 'msearch', 'updateByQuery', 'deleteByQuery', 'mget', 'exists']);
const SIO_BUILTIN = new Set(['connection', 'connect', 'disconnect', 'disconnecting', 'error', 'close', 'message', 'open', 'listening', 'headers', 'upgrade', 'ping', 'pong', 'data', 'end', 'finish', 'drain', 'exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'ready', 'request', 'response', 'timeout', 'abort', 'reconnect', 'connect_error']);

export const AWS_V3: Record<string, [Extract<Op, { k: 'aws' }>['svc'], string]> = {
  SendMessageCommand: ['sqs', 'SendMessage'], SendMessageBatchCommand: ['sqs', 'SendMessageBatch'], ReceiveMessageCommand: ['sqs', 'ReceiveMessage'], DeleteMessageCommand: ['sqs', 'DeleteMessage'],
  PublishCommand: ['sns', 'Publish'], PublishBatchCommand: ['sns', 'PublishBatch'], SubscribeCommand: ['sns', 'Subscribe'],
  PutEventsCommand: ['eventbridge', 'PutEvents'],
  InvokeCommand: ['lambda', 'Invoke'], InvokeAsyncCommand: ['lambda', 'InvokeAsync'],
  PutObjectCommand: ['s3', 'PutObject'], GetObjectCommand: ['s3', 'GetObject'], DeleteObjectCommand: ['s3', 'DeleteObject'], HeadObjectCommand: ['s3', 'HeadObject'], CopyObjectCommand: ['s3', 'CopyObject'], ListObjectsV2Command: ['s3', 'ListObjects'], ListObjectsCommand: ['s3', 'ListObjects'], DeleteObjectsCommand: ['s3', 'DeleteObjects'], CreateMultipartUploadCommand: ['s3', 'PutObject'],
  PutItemCommand: ['dynamodb', 'PutItem'], GetItemCommand: ['dynamodb', 'GetItem'], UpdateItemCommand: ['dynamodb', 'UpdateItem'], DeleteItemCommand: ['dynamodb', 'DeleteItem'], QueryCommand: ['dynamodb', 'Query'], ScanCommand: ['dynamodb', 'Scan'],
  BatchWriteItemCommand: ['dynamodb', 'BatchWrite'], BatchGetItemCommand: ['dynamodb', 'BatchGet'], TransactWriteItemsCommand: ['dynamodb', 'TransactWrite'], TransactGetItemsCommand: ['dynamodb', 'TransactGet'],
  PutCommand: ['dynamodb', 'PutItem'], GetCommand: ['dynamodb', 'GetItem'], UpdateCommand: ['dynamodb', 'UpdateItem'], DeleteCommand: ['dynamodb', 'DeleteItem'], BatchWriteCommand: ['dynamodb', 'BatchWrite'], BatchGetCommand: ['dynamodb', 'BatchGet'], TransactWriteCommand: ['dynamodb', 'TransactWrite'], TransactGetCommand: ['dynamodb', 'TransactGet'],
};
const AWS_V2: Record<string, [Extract<Op, { k: 'aws' }>['svc'], string, string]> = {
  sendMessage: ['sqs', 'SendMessage', 'QueueUrl'], sendMessageBatch: ['sqs', 'SendMessageBatch', 'QueueUrl'], receiveMessage: ['sqs', 'ReceiveMessage', 'QueueUrl'],
  publish: ['sns', 'Publish', 'TopicArn'], subscribe: ['sns', 'Subscribe', 'TopicArn'],
  putEvents: ['eventbridge', 'PutEvents', 'Entries'],
  invoke: ['lambda', 'Invoke', 'FunctionName'], invokeAsync: ['lambda', 'InvokeAsync', 'FunctionName'],
  putObject: ['s3', 'PutObject', 'Bucket'], getObject: ['s3', 'GetObject', 'Bucket'], upload: ['s3', 'PutObject', 'Bucket'], deleteObject: ['s3', 'DeleteObject', 'Bucket'], headObject: ['s3', 'HeadObject', 'Bucket'], copyObject: ['s3', 'CopyObject', 'Bucket'], listObjectsV2: ['s3', 'ListObjects', 'Bucket'], listObjects: ['s3', 'ListObjects', 'Bucket'], getSignedUrl: ['s3', 'GetObject', 'Bucket'], getSignedUrlPromise: ['s3', 'GetObject', 'Bucket'],
  put: ['dynamodb', 'PutItem', 'TableName'], get: ['dynamodb', 'GetItem', 'TableName'], update: ['dynamodb', 'UpdateItem', 'TableName'], delete: ['dynamodb', 'DeleteItem', 'TableName'], query: ['dynamodb', 'Query', 'TableName'], scan: ['dynamodb', 'Scan', 'TableName'],
  putItem: ['dynamodb', 'PutItem', 'TableName'], getItem: ['dynamodb', 'GetItem', 'TableName'], updateItem: ['dynamodb', 'UpdateItem', 'TableName'], deleteItem: ['dynamodb', 'DeleteItem', 'TableName'],
  batchWrite: ['dynamodb', 'BatchWrite', 'RequestItems'], batchGet: ['dynamodb', 'BatchGet', 'RequestItems'], transactWrite: ['dynamodb', 'TransactWrite', 'TransactItems'],
};

// ------------------------------------------------------------------ analysis

export function emptyFacts(file: string, error?: string): FileFacts {
  return { file, exports: new Map(), stars: [], imports: new Map(), fns: new Map(), classes: new Map(), routes: [], mounts: [], consumers: [], listens: [], globalPrefixes: [], handlerRefs: [], types: new Map(), moduleFn: `${file}#<module>`, error };
}

export function analyzeFile(file: string, src: string): FileFacts {
  const facts: FileFacts = {
    file,
    exports: new Map(),
    stars: [],
    imports: new Map(),
    fns: new Map(),
    classes: new Map(),
    routes: [],
    mounts: [],
    consumers: [],
    listens: [],
    globalPrefixes: [],
    handlerRefs: [],
    types: new Map(),
    moduleFn: `${file}#<module>`,
  };
  let ast: any;
  try {
    ast = parse(src, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins: [/\.(m|c)?tsx?$/.test(file) ? 'typescript' : 'flow', 'jsx', 'decorators-legacy', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'topLevelAwait', 'importMeta', 'dynamicImport', 'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator'] as any,
    });
  } catch (e: any) {
    facts.error = String(e?.message ?? e);
    return facts;
  }
  const lines = src.split('\n');
  const loc = (node: any): Loc => {
    const l = node?.loc?.start ?? { line: 0, column: 0 };
    return { file, line: l.line, col: l.column + 1, snippet: (lines[l.line - 1] ?? '').trim().slice(0, 200) };
  };

  // ---------- ids
  const ids = new WeakMap<object, string>();
  const fnId = (p: NodePath<any>): string => {
    const n = p.node;
    const cached = ids.get(n);
    if (cached) return cached;
    const at = `@${n.loc?.start.line ?? 0}:${n.loc?.start.column ?? 0}`;
    let id: string;
    const parent = p.parentPath;
    const topStmt = (q: NodePath<any> | null | undefined) => !!q && (q.parentPath?.isProgram() || q.parentPath?.isExportNamedDeclaration() || q.parentPath?.isExportDefaultDeclaration());
    if ((p.isFunctionDeclaration() || p.isClassDeclaration()) && n.id) {
      id = topStmt(p) || p.parentPath?.isProgram() ? `${file}#${n.id.name}` : `${file}#${n.id.name}${at}`;
    } else if ((p.isClassMethod() || p.isClassPrivateMethod() || p.isClassProperty()) && p.parentPath?.parentPath) {
      const cls = p.parentPath.parentPath;
      const key = n.key?.name ?? n.key?.value ?? n.key?.id?.name ?? 'anon';
      id = `${fnId(cls)}.${n.kind === 'constructor' ? 'constructor' : key}`;
    } else if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
      const decl = parent.parentPath;
      id = topStmt(decl) ? `${file}#${parent.node.id.name}` : `${file}#${parent.node.id.name}${at}`;
    } else if (parent?.isClassProperty() && parent.parentPath?.parentPath) {
      id = `${fnId(parent.parentPath.parentPath)}.${(parent.node.key as any)?.name ?? 'anon'}`;
    } else if (p.isObjectMethod() || (parent?.isObjectProperty() && parent.node.value === n)) {
      const key = (p.isObjectMethod() ? n.key : parent!.node.key) as any;
      id = `${file}#${key?.name ?? key?.value ?? 'anon'}${at}`;
    } else if (parent?.isAssignmentExpression() && parent.node.left.type === 'MemberExpression') {
      const prop = parent.node.left.property as any;
      id = `${file}#${prop?.name ?? prop?.value ?? 'anon'}${at}`;
    } else if (n.id?.name) {
      id = `${file}#${n.id.name}${at}`;
    } else {
      id = `${file}#${p.isClass() ? 'class' : 'fn'}${at}`;
    }
    ids.set(n, id);
    return id;
  };
  const enclosingFn = (p: NodePath<any>): string => {
    const f = p.getFunctionParent();
    return f ? fnId(f) : facts.moduleFn;
  };
  const enclosingClass = (p: NodePath<any>): NodePath<any> | undefined => {
    let q: NodePath<any> | null = p.parentPath;
    while (q) {
      if (q.isClass()) return q;
      q = q.parentPath;
    }
    return undefined;
  };

  const getFn = (id: string, p?: NodePath<any>): FnFacts => {
    let f = facts.fns.get(id);
    if (!f) {
      const n = p?.node;
      f = {
        id,
        name: id.split('#')[1]?.replace(/@.*$/, '') ?? id,
        file,
        params: (n?.params ?? []).map((q: any) => paramName(q)),
        paramTypes: [],
        paramDecorators: {},
        calls: [],
        ops: [],
        returns: [],
        loc: loc(n ?? ast.program),
        decorators: [],
      };
      facts.fns.set(id, f);
    }
    return f;
  };
  getFn(facts.moduleFn);
  const addOp = (p: NodePath<any>, op: any) => getFn(enclosingFn(p)).ops.push({ ...op, loc: loc(p.node) });

  // ---------- value evaluation
  const inProgress = new Set<object>();

  const valueOf = (p: NodePath<any> | null | undefined, depth = 0): Sym => {
    if (!p || !p.node) return { t: 'dyn', hint: 'x' };
    if (depth > 20 || inProgress.has(p.node)) return { t: 'dyn', hint: hintOf(p.node) };
    inProgress.add(p.node);
    try {
      return normEnv(valueOfInner(p, depth));
    } finally {
      inProgress.delete(p.node);
    }
  };

  const valueOfInner = (p: NodePath<any>, depth: number): Sym => {
    const n = p.node;
    switch (n.type) {
      case 'StringLiteral':
        return { t: 'str', v: n.value };
      case 'NumericLiteral':
        return { t: 'num', v: n.value };
      case 'BooleanLiteral':
        return { t: 'bool' };
      case 'NullLiteral':
        return { t: 'null' };
      case 'TemplateLiteral': {
        const parts: Sym[] = [];
        const exprs = p.get('expressions') as NodePath<any>[];
        n.quasis.forEach((q: any, i: number) => {
          if (q.value.cooked) parts.push({ t: 'str', v: q.value.cooked });
          if (exprs[i]) parts.push(valueOf(exprs[i], depth + 1));
        });
        return { t: 'concat', parts };
      }
      case 'BinaryExpression':
        if (n.operator === '+') return { t: 'concat', parts: [valueOf(p.get('left') as any, depth + 1), valueOf(p.get('right') as any, depth + 1)] };
        return { t: 'dyn', hint: 'expr' };
      case 'LogicalExpression': {
        const l = valueOf(p.get('left') as any, depth + 1);
        const r = valueOf(p.get('right') as any, depth + 1);
        if (n.operator === '&&') return r;
        if (l.t === 'env') return { t: 'env', name: l.name, fallback: l.fallback ? { t: 'alt', opts: [l.fallback, r] } : r };
        if (l.t === 'dyn' || l.t === 'null') return r;
        return { t: 'alt', opts: [l, r] };
      }
      case 'ConditionalExpression':
        return { t: 'alt', opts: [valueOf(p.get('consequent') as any, depth + 1), valueOf(p.get('alternate') as any, depth + 1)] };
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TypeCastExpression':
        return valueOf(p.get('expression') as any, depth + 1);
      case 'AwaitExpression':
        return valueOf(p.get('argument') as any, depth + 1);
      case 'ObjectExpression': {
        const fields: Record<string, Sym> = {};
        const spread: Sym[] = [];
        for (const pp of p.get('properties') as NodePath<any>[]) {
          if (pp.isSpreadElement()) spread.push(valueOf(pp.get('argument') as any, depth + 1));
          else if (pp.isObjectProperty()) {
            const k = propKey(pp.node);
            if (k !== undefined) fields[k] = valueOf(pp.get('value') as any, depth + 1);
          } else if (pp.isObjectMethod()) {
            const k = propKey(pp.node);
            if (k !== undefined) fields[k] = { t: 'fn', id: fnId(pp) };
          }
        }
        return { t: 'obj', fields, spread: spread.length ? spread : undefined };
      }
      case 'ArrayExpression': {
        const el = (p.get('elements') as NodePath<any>[])[0];
        return { t: 'arr', item: el?.node ? valueOf(el, depth + 1) : undefined };
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'FunctionDeclaration':
        return { t: 'fn', id: fnId(p) };
      case 'ClassExpression':
      case 'ClassDeclaration':
        return { t: 'class', id: fnId(p) };
      case 'ThisExpression': {
        const cls = enclosingClass(p);
        return cls ? { t: 'inst', cls: { t: 'class', id: fnId(cls) } } : { t: 'dyn', hint: 'this' };
      }
      case 'Identifier':
        return identValue(p, depth);
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const obj = p.get('object') as NodePath<any>;
        const key = memberKey(n);
        if (isProcessEnv(obj.node)) return key ? { t: 'env', name: key } : { t: 'dyn', hint: 'env' };
        if (obj.node.type === 'MetaProperty' && key === 'env') return { t: 'ext', mod: '__env', path: [] };
        if (key === undefined) return { t: 'dyn', hint: hintOf(n.property) };
        if (obj.node.type === 'Identifier' && obj.node.name === 'process' && key === 'env') return { t: 'ext', mod: '__env', path: [] };
        return member(valueOf(obj, depth + 1), key);
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
        return callValue(p, depth);
      case 'NewExpression':
        return newValue(p, depth);
      case 'TaggedTemplateExpression':
        return valueOf(p.get('quasi') as any, depth + 1);
      case 'SequenceExpression': {
        const ex = p.get('expressions') as NodePath<any>[];
        return valueOf(ex[ex.length - 1], depth + 1);
      }
      case 'AssignmentExpression':
        return valueOf(p.get('right') as any, depth + 1);
      default:
        return { t: 'dyn', hint: hintOf(n) };
    }
  };

  const identValue = (p: NodePath<any>, depth: number): Sym => {
    const name: string = p.node.name;
    if (name === 'undefined') return { t: 'null' };
    const b = p.scope.getBinding(name);
    if (!b) {
      if (name === 'fetch') return { t: 'ext', mod: 'fetch', path: [] };
      if (name === 'WebSocket') return { t: 'ext', mod: 'WebSocket', path: [] };
      return { t: 'dyn', hint: name };
    }
    const bp = b.path as NodePath<any>;
    if (b.kind === 'module') {
      const decl = bp.parentPath?.node as any;
      const source: string = decl?.source?.value ?? '';
      const imported = bp.isImportDefaultSpecifier() ? 'default' : bp.isImportNamespaceSpecifier() ? '*' : (bp.node.imported?.name ?? bp.node.imported?.value ?? name);
      return importSym(source, imported, []);
    }
    if (b.kind === 'param') {
      const fnNode = b.scope.block as any;
      const fnPath = b.scope.path as NodePath<any>;
      const idx = (fnNode.params ?? []).findIndex((q: any) => contains(q, b.identifier));
      if (idx >= 0) {
        const pth = patternPath(fnNode.params[idx], b.identifier) ?? [];
        return { t: 'param', fn: fnId(fnPath), i: idx, path: pth.length ? pth : undefined, name };
      }
      return { t: 'dyn', hint: name };
    }
    if (bp.isFunctionDeclaration()) return { t: 'fn', id: fnId(bp) };
    if (bp.isClassDeclaration()) return { t: 'class', id: fnId(bp) };
    if (bp.isVariableDeclarator()) {
      const init = bp.get('init') as NodePath<any>;
      if (!init.node) return { t: 'dyn', hint: name };
      const v = valueOf(init, depth + 1);
      if (bp.node.id.type === 'Identifier') return v;
      const pth = patternPath(bp.node.id, b.identifier);
      if (!pth) return { t: 'dyn', hint: name };
      let out = v;
      for (const k of pth) out = member(out, k);
      return out;
    }
    if (bp.isTSEnumDeclaration() || bp.isTSInterfaceDeclaration() || bp.isTSTypeAliasDeclaration()) return { t: 'type', name, file };
    return { t: 'dyn', hint: name };
  };

  const importSym = (source: string, imported: string, path: string[]): Sym => {
    const mod = source.replace(/^node:/, '');
    if (KNOWN_MODS.has(mod) || mod.startsWith('@aws-sdk/')) return { t: 'ext', mod, path: imported === '*' || imported === 'default' ? path : [imported, ...path] };
    return { t: 'ref', file, source, imported, path: path.length ? path : undefined };
  };

  const calleeName = (n: any): string => (n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' ? memberKey(n) ?? '' : '');

  const callValue = (p: NodePath<any>, depth: number): Sym => {
    const n = p.node;
    const callee = p.get('callee') as NodePath<any>;
    const args = p.get('arguments') as NodePath<any>[];
    const cn = calleeName(n.callee);
    if (n.callee.type === 'Identifier' && (cn === 'require' || cn === 'import') && args[0]?.isStringLiteral()) return importSym(args[0].node.value, '*', []);
    if (n.callee.type === 'Import' && args[0]?.isStringLiteral()) return importSym(args[0].node.value, '*', []);
    if (n.callee.type === 'MemberExpression') {
      const obj = n.callee.object;
      if (obj.type === 'Identifier' && obj.name === 'JSON') {
        if (cn === 'stringify') return { t: 'json', of: valueOf(args[0], depth + 1) };
        if (cn === 'parse') return valueOf(args[0], depth + 1);
      }
      if (['toString', 'trim', 'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'concat', 'routes', 'middleware', 'then', 'promise', 'exec', 'lean', 'toJSON', 'valueOf', 'default'].includes(cn) && cn !== 'concat') {
        if (cn === 'then' || cn === 'exec' || cn === 'lean' || cn === 'promise') return { t: 'dyn', hint: cn };
        return valueOf(callee.get('object') as any, depth + 1);
      }
      if ((obj.type === 'Identifier' && (obj.name === 'path' || obj.name === 'posix') && (cn === 'join' || cn === 'resolve')) || (obj.type === 'Identifier' && obj.name === 'url' && cn === 'resolve')) {
        const parts: Sym[] = [];
        args.forEach((a, i) => {
          if (i) parts.push({ t: 'str', v: '/' });
          parts.push(valueOf(a, depth + 1));
        });
        return { t: 'concat', parts };
      }
    }
    if (cn === 'String' || cn === 'encodeURIComponent' || cn === 'encodeURI') return n.callee.type === 'Identifier' && cn === 'String' ? valueOf(args[0], depth + 1) : { t: 'dyn', hint: hintOf(n.arguments[0]) };
    if (cn === 'Number' || cn === 'parseInt' || cn === 'parseFloat') return { t: 'dyn', hint: hintOf(n.arguments[0]) };

    const cs = valueOf(callee, depth + 1);
    // schema builders → shapes
    const sch = schemaShape(n, rootExt);
    if (sch) return { t: 'shape', shape: sch };

    if (cs.t === 'ext') {
      const k = extKey(cs);
      const a0 = args[0] ? valueOf(args[0], depth + 1) : undefined;
      switch (k) {
        case 'axios.create':
          return { t: 'obj', fields: { ...(a0?.t === 'obj' ? a0.fields : {}), __kind: { t: 'str', v: 'axios' } } };
        case 'got.extend':
          return { t: 'obj', fields: { baseURL: a0?.t === 'obj' ? a0.fields.prefixUrl ?? { t: 'null' } : { t: 'null' }, __kind: { t: 'str', v: 'axios' } } };
        case 'ky.create':
        case 'ky.extend':
          return { t: 'obj', fields: { baseURL: a0?.t === 'obj' ? a0.fields.prefixUrl ?? { t: 'null' } : { t: 'null' }, __kind: { t: 'str', v: 'axios' } } };
        case 'express':
        case 'express.Router':
        case 'express.default':
        case 'express.Router.default':
        case 'restify.createServer':
          return router('express', p, a0);
        case 'fastify':
        case 'fastify.default':
        case 'fastify.fastify':
          return router('fastify', p, a0);
        case '@hapi/hapi.server':
        case 'hapi.server':
          return router('hapi', p, a0);
        case 'socket.io':
        case 'socket.io.default':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'sio-server' }, __id: { t: 'str', v: idAt(p) } } };
        case 'socket.io-client':
        case 'socket.io-client.io':
        case 'socket.io-client.connect':
        case 'socket.io-client.default':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'sio-client' }, url: a0 ?? { t: 'str', v: '/' } } };
        case 'redis.createClient':
        case 'redis.createCluster':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'redis' }, cfg: a0 ?? { t: 'null' } } };
        case 'mysql.createPool':
        case 'mysql.createConnection':
        case 'mysql2.createPool':
        case 'mysql2.createConnection':
        case 'mysql2/promise.createPool':
        case 'mysql2/promise.createConnection':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'sql' }, db: { t: 'str', v: 'mysql' } } };
        case 'postgres':
        case 'postgres.default':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'sql' }, db: { t: 'str', v: 'postgres' } } };
        case 'knex':
        case 'knex.knex':
        case 'knex.default':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'knex' } } };
        case 'mongoose.model':
          return mongooseModel(args, depth);
        case 'typeorm.getRepository':
        case 'typeorm.getMongoRepository':
          return { t: 'obj', fields: { __kind: { t: 'str', v: 'repo' }, entity: a0 ?? { t: 'null' } } };
      }
    }
    if (n.callee.type === 'MemberExpression') {
      const m = cn;
      if (m === 'getRepository' || m === 'getMongoRepository' || m === 'getTreeRepository') return { t: 'obj', fields: { __kind: { t: 'str', v: 'repo' }, entity: args[0] ? valueOf(args[0], depth + 1) : { t: 'null' } } };
      if (m === 'model' && args[0]?.isStringLiteral() && args.length >= 2) return mongooseModel(args, depth);
      if (m === 'define' && args[0]?.isStringLiteral() && args.length >= 2 && args[1].isObjectExpression()) {
        const opts = args[2] ? valueOf(args[2], depth + 1) : undefined;
        const tn = opts?.t === 'obj' ? opts.fields.tableName : undefined;
        return { t: 'obj', fields: { __kind: { t: 'str', v: 'model' }, db: { t: 'str', v: 'sql' }, table: tn ?? { t: 'str', v: plural(args[0].node.value) }, name: { t: 'str', v: args[0].node.value } } };
      }
      if (m === 'collection' && args[0] && !args[0].isFunction()) return { t: 'obj', fields: { __kind: { t: 'str', v: 'mongo-coll' }, name: valueOf(args[0], depth + 1) } };
      if (m === 'duplicate' || m === 'multi' || m === 'pipeline') return valueOf(callee.get('object') as any, depth + 1);
    }
    // schema.parse(x) → the schema's shape
    if (n.callee.type === 'MemberExpression' && ['parse', 'parseAsync', 'validateSync', 'cast'].includes(cn)) {
      const r = valueOf(callee.get('object') as any, depth + 1);
      if (r.t === 'shape') return r;
    }
    // local helper whose return value is computable: getBaseUrl() → value
    if (cs.t === 'fn') {
      const fp = findFnPath(cs.id);
      if (fp && (fp.node.params?.length ?? 0) === 0) {
        if (fp.node.body?.type && fp.node.body.type !== 'BlockStatement') return valueOf(fp.get('body') as any, depth + 1);
        const rets: NodePath<any>[] = [];
        fp.traverse({ ReturnStatement(rp: NodePath<any>) { if (rp.getFunctionParent()?.node === fp.node && rp.node.argument) rets.push(rp.get('argument') as any); }, Function(q: NodePath<any>) { q.skip(); } });
        if (rets.length === 1) return valueOf(rets[0], depth + 1);
      }
    }
    if (cs.t === 'fn' || cs.t === 'ref' || (cs.t === 'inst' && cs.path?.length)) return { t: 'ret', fn: cs, args: args.map((a) => valueOf(a, depth + 1)) };
    return { t: 'dyn', hint: cn || 'call' };
  };

  const mongooseModel = (args: NodePath<any>[], depth: number): Sym => {
    const name = args[0]?.isStringLiteral() ? args[0].node.value : 'model';
    const coll = args[2] ? valueOf(args[2], depth + 1) : { t: 'str' as const, v: plural(name.toLowerCase()) };
    return { t: 'obj', fields: { __kind: { t: 'str', v: 'model' }, db: { t: 'str', v: 'mongo' }, table: coll, name: { t: 'str', v: name } } };
  };

  const router = (fw: string, p: NodePath<any>, opts?: Sym): Sym => ({
    t: 'obj',
    fields: { __kind: { t: 'str', v: 'router' }, fw: { t: 'str', v: fw }, __id: { t: 'str', v: idAt(p) }, prefix: opts?.t === 'obj' && opts.fields.prefix ? opts.fields.prefix : { t: 'null' } },
  });
  const idAt = (p: NodePath<any>) => `${file}:${p.node.loc?.start.line}:${p.node.loc?.start.column}`;

  const newValue = (p: NodePath<any>, depth: number): Sym => {
    const n = p.node;
    const callee = p.get('callee') as NodePath<any>;
    const args = p.get('arguments') as NodePath<any>[];
    const a0 = args[0] ? valueOf(args[0], depth + 1) : undefined;
    const cs = valueOf(callee, depth + 1);
    const cname = calleeName(n.callee);
    if (/^(Map|Set|WeakMap|WeakSet|LRUCache|LRU|NodeCache)$/.test(cname) && !p.scope.getBinding(cname)?.path.isClassDeclaration()) return { t: 'obj', fields: { __kind: { t: 'str', v: 'map' } } };
    if (cname === 'URL' && args.length) {
      if (args[1]) return { t: 'concat', parts: [valueOf(args[1], depth + 1), a0!] };
      return a0!;
    }
    if (cs.t === 'ext') {
      const k = extKey(cs);
      if (k === 'WebSocket' || ((k === 'ws' || k === 'ws.WebSocket' || k === 'ws.default') && a0 && a0.t !== 'obj') || k === 'reconnecting-websocket') return { t: 'obj', fields: { __kind: { t: 'str', v: 'ws-client' }, url: a0 ?? { t: 'str', v: '/' } } };
      if (k === 'ws.Server' || k === 'ws.WebSocketServer' || ((k === 'ws' || k === 'ws.default') && a0?.t === 'obj')) return { t: 'obj', fields: { __kind: { t: 'str', v: 'ws-server' }, __id: { t: 'str', v: idAt(p) }, ...(a0?.t === 'obj' ? a0.fields : {}) } };
      if (k === 'socket.io.Server' || k === 'socket.io') return { t: 'obj', fields: { __kind: { t: 'str', v: 'sio-server' }, __id: { t: 'str', v: idAt(p) } } };
      if (k.startsWith('ioredis') || k === 'redis.Redis') return { t: 'obj', fields: { __kind: { t: 'str', v: 'redis' } } };
      if (k === 'pg.Pool' || k === 'pg.Client' || k === 'pg.default.Pool' || k === 'pg.default.Client') return { t: 'obj', fields: { __kind: { t: 'str', v: 'sql' }, db: { t: 'str', v: 'postgres' }, cfg: a0 ?? { t: 'null' } } };
      if (k === 'mssql.ConnectionPool') return { t: 'obj', fields: { __kind: { t: 'str', v: 'sql' }, db: { t: 'str', v: 'mssql' } } };
      if (k === 'better-sqlite3' || k === 'sqlite3.Database') return { t: 'obj', fields: { __kind: { t: 'str', v: 'sql' }, db: { t: 'str', v: 'sqlite' } } };
      if (k === '@prisma/client.PrismaClient') return { t: 'obj', fields: { __kind: { t: 'str', v: 'prisma' } } };
      if (k === 'sequelize' || k === 'sequelize.Sequelize' || k === 'sequelize-typescript.Sequelize') return { t: 'obj', fields: { __kind: { t: 'str', v: 'sequelize' } } };
      if (k === 'koa' || k === 'koa.default') return router('koa', p);
      if (k === '@koa/router' || k === 'koa-router' || k === '@koa/router.default' || k === 'koa-router.default') return router('koa', p, a0);
      if (k === '@hapi/hapi.Server' || k === 'hapi.Server') return router('hapi', p, a0);
      if (k === '@elastic/elasticsearch.Client' || k === 'elasticsearch.Client' || k === '@opensearch-project/opensearch.Client') return { t: 'obj', fields: { __kind: { t: 'str', v: 'es' } } };
      if (k === 'mongoose.Schema') return { t: 'dyn', hint: 'schema' };
      if (k === 'mongodb.MongoClient') return { t: 'obj', fields: { __kind: { t: 'str', v: 'mongo-client' } } };
    }
    if (cname && cname.endsWith('Command') && Object.hasOwn(AWS_V3, cname)) return { t: 'obj', fields: { __kind: { t: 'str', v: 'aws-cmd' }, input: a0 ?? { t: 'null' } } };
    if (cs.t === 'class' || cs.t === 'ref' || cs.t === 'inst') return { t: 'inst', cls: cs };
    if (cs.t === 'ext') return { t: 'inst', cls: cs };
    return { t: 'dyn', hint: cname || 'new' };
  };

  const rootExt = (node: any): string | undefined => {
    // walk to the root identifier of a member/call chain and see whether it's an external module
    let n = node;
    while (n && (n.type === 'CallExpression' || n.type === 'MemberExpression')) n = n.type === 'CallExpression' ? n.callee : n.object;
    if (n?.type !== 'Identifier') return undefined;
    return extOfName(n.name);
  };
  const extNames = new Map<string, string>();
  const extOfName = (name: string) => extNames.get(name);

  const findFnPath = (id: string): NodePath<any> | undefined => fnPaths.get(id);
  const fnPaths = new Map<string, NodePath<any>>();

  // ---------- helpers for detectors
  const strArg = (p: NodePath<any> | undefined) => (p?.isStringLiteral() ? p.node.value : p?.isTemplateLiteral() && p.node.expressions.length === 0 ? p.node.quasis[0].value.cooked : undefined);
  const isFnLike = (p: NodePath<any> | undefined) => !!p && (p.isFunctionExpression() || p.isArrowFunctionExpression());
  const typeArg = (n: any): any => n.typeParameters?.params?.[0] ?? n.typeArguments?.params?.[0];

  const typeSym = (ann: any, scopePath: NodePath<any>): Sym | undefined => {
    if (!ann) return undefined;
    if (ann.type === 'TSTypeAnnotation') return typeSym(ann.typeAnnotation, scopePath);
    if (ann.type === 'TSArrayType') {
      const s = typeSym(ann.elementType, scopePath);
      return s?.t === 'type' ? { ...s, array: true } : s ? { t: 'arr', item: s } : undefined;
    }
    if (ann.type === 'TSTypeReference' && ann.typeName?.type === 'Identifier') {
      const name = ann.typeName.name;
      if ((name === 'Array' || name === 'Promise' || name === 'Partial' || name === 'Readonly') && ann.typeParameters?.params?.[0]) {
        const s = typeSym(ann.typeParameters.params[0], scopePath);
        return name === 'Array' && s?.t === 'type' ? { ...s, array: true } : s;
      }
      return { t: 'type', name, file };
    }
    if (ann.type === 'TSTypeLiteral') return { t: 'shape', shape: tsTypeToShape(ann) };
    return undefined;
  };

  /** For DI: a constructor param / property type → instance value (class) for method resolution. */
  const instFromType = (ann: any, p: NodePath<any>): Sym | undefined => {
    const a = ann?.type === 'TSTypeAnnotation' ? ann.typeAnnotation : ann;
    if (a?.type !== 'TSTypeReference' || a.typeName?.type !== 'Identifier') return undefined;
    const b = p.scope.getBinding(a.typeName.name);
    if (!b) return undefined;
    const bp = b.path as NodePath<any>;
    if (bp.isClassDeclaration()) return { t: 'inst', cls: { t: 'class', id: fnId(bp) } };
    if (b.kind === 'module') {
      const source = (bp.parentPath?.node as any)?.source?.value ?? '';
      const imported = bp.isImportDefaultSpecifier() ? 'default' : bp.isImportNamespaceSpecifier() ? '*' : (bp.node.imported?.name ?? a.typeName.name);
      return { t: 'inst', cls: importSym(source, imported, []) };
    }
    return undefined;
  };

  const decoratorsOf = (node: any, p: NodePath<any>): { name: string; args: (Sym | undefined)[] }[] => {
    const out: { name: string; args: (Sym | undefined)[] }[] = [];
    const decos = node.decorators as any[] | undefined;
    if (!decos) return out;
    const dps = (p.get('decorators') as NodePath<any>[]) ?? [];
    decos.forEach((d, i) => {
      const e = d.expression;
      const dp = dps[i];
      if (e.type === 'CallExpression') out.push({ name: calleeName(e.callee), args: (dp.get('expression.arguments') as NodePath<any>[]).map((a) => valueOf(a)) });
      else out.push({ name: calleeName(e), args: [] });
    });
    return out;
  };

  // ---------- pre-pass: register functions/classes, imports, ext aliases
  traverse(ast, {
    Function(p: NodePath<any>) {
      const id = fnId(p);
      fnPaths.set(id, p);
    },
    ImportDeclaration(p: NodePath<any>) {
      const source = p.node.source.value;
      for (const s of p.node.specifiers) {
        const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : (s.imported?.name ?? s.imported?.value);
        facts.imports.set(s.local.name, { source, imported });
        const mod = source.replace(/^node:/, '');
        if (KNOWN_MODS.has(mod)) extNames.set(s.local.name, imported === 'default' || imported === '*' ? mod : `${mod}.${imported}`);
      }
    },
    VariableDeclarator(p: NodePath<any>) {
      const init = p.node.init;
      if (init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require' && init.arguments[0]?.type === 'StringLiteral') {
        const source = init.arguments[0].value;
        const mod = source.replace(/^node:/, '');
        if (p.node.id.type === 'Identifier') {
          facts.imports.set(p.node.id.name, { source, imported: '*' });
          if (KNOWN_MODS.has(mod)) extNames.set(p.node.id.name, mod);
        } else if (p.node.id.type === 'ObjectPattern') {
          for (const prop of p.node.id.properties) {
            if (prop.type !== 'ObjectProperty' || prop.value.type !== 'Identifier') continue;
            const k = propKey(prop);
            if (!k) continue;
            facts.imports.set(prop.value.name, { source, imported: k });
            if (KNOWN_MODS.has(mod)) extNames.set(prop.value.name, `${mod}.${k}`);
          }
        }
      }
    },
  });

  // ---------- main pass
  const registeredHandlerNodes = new WeakSet<object>();

  traverse(ast, {
    Function: {
      enter(p: NodePath<any>) {
        const id = fnId(p);
        const f = getFn(id, p);
        const cls = enclosingClass(p);
        if (cls && (p.isClassMethod() || p.parentPath?.isClassProperty())) f.className = fnId(cls);
        if (p.isClassMethod()) {
          f.decorators = decoratorsOf(p.node, p);
          (p.get('params') as NodePath<any>[]).forEach((pp, i) => {
            const pn = pp.node.type === 'TSParameterProperty' ? pp.node.parameter : pp.node;
            f.paramTypes[i] = typeSym(pn.typeAnnotation, p);
            const d = decoratorsOf(pp.node, pp);
            if (d.length) f.paramDecorators[i] = d[0].name;
          });
        } else {
          (p.node.params as any[]).forEach((pn, i) => (f.paramTypes[i] = typeSym(pn.typeAnnotation, p)));
        }
        // param destructuring reads: ({ body: { a } }, res) => ...
        (p.node.params as any[]).forEach((pn, i) => {
          if (pn.type === 'ObjectPattern' || (pn.type === 'AssignmentPattern' && pn.left.type === 'ObjectPattern')) {
            for (const leaf of leafPaths(pn.type === 'AssignmentPattern' ? pn.left : pn)) {
              if (leaf.length > 1 && /^(body|payload|query|params|request)$/.test(leaf[0])) f.ops.push({ k: 'reads', sym: { t: 'param', fn: id, i, path: leaf }, loc: loc(pn) });
            }
          }
        });
        // constructor: TS parameter properties & this.x = ... assignments
        if (p.isClassMethod() && p.node.kind === 'constructor' && cls) {
          const cf = getClass(cls);
          (p.get('params') as NodePath<any>[]).forEach((pp, i) => {
            const n = pp.node;
            const inner = n.type === 'TSParameterProperty' ? n.parameter : n;
            const name = inner.type === 'Identifier' ? inner.name : inner.left?.name;
            if (!name) return;
            const decos = decoratorsOf(n, pp);
            const repo = decos.find((d) => d.name === 'InjectRepository');
            const model = decos.find((d) => d.name === 'InjectModel');
            let v: Sym | undefined;
            if (repo) v = { t: 'obj', fields: { __kind: { t: 'str', v: 'repo' }, entity: repo.args[0] ?? { t: 'null' } } };
            else if (model) {
              const nm = model.args[0];
              const mn = nm?.t === 'str' ? nm.v : nm?.t === 'fn' ? nm.id.split('.').at(-2)?.split('#').pop() : nm?.t === 'ref' ? nm.imported : undefined;
              v = { t: 'obj', fields: { __kind: { t: 'str', v: 'model' }, db: { t: 'str', v: 'mongo' }, table: { t: 'str', v: plural(String(mn ?? 'model').toLowerCase()) } } };
            } else v = instFromType(inner.typeAnnotation, p);
            if (n.type === 'TSParameterProperty' || decos.length) cf.fields[name] = v ?? { t: 'dyn', hint: name };
            else if (v) {
              // plain param: record as param type so `this.x = x` picks it up
              f.paramTypes[i] = v;
            }
          });
        }
      },
    },

    Class(p: NodePath<any>) {
      const cf = getClass(p);
      cf.decorators = decoratorsOf(p.node, p);
      if (p.node.superClass) cf.superClass = valueOf(p.get('superClass') as any);
      for (const bp of p.get('body.body') as NodePath<any>[]) {
        const n = bp.node;
        const key = n.key?.name ?? n.key?.value;
        if (!key) continue;
        if (bp.isClassMethod() || bp.isClassPrivateMethod()) cf.methods.push(key);
        else if (bp.isClassProperty() || bp.isClassPrivateProperty()) {
          if (n.value && (n.value.type === 'ArrowFunctionExpression' || n.value.type === 'FunctionExpression')) {
            cf.methods.push(key);
            continue;
          }
          const decos = decoratorsOf(n, bp);
          const repo = decos.find((d) => d.name === 'InjectRepository');
          if (repo) cf.fields[key] = { t: 'obj', fields: { __kind: { t: 'str', v: 'repo' }, entity: repo.args[0] ?? { t: 'null' } } };
          else if (n.value) cf.fields[key] = valueOf(bp.get('value') as any);
          else if (n.typeAnnotation) {
            const v = instFromType(n.typeAnnotation, bp);
            if (v) cf.fields[key] = v;
          }
        }
      }
      // TS-ish class → type shape (DTOs)
      if (p.node.id?.name) {
        const sh = tsTypeToShape(p.node);
        if (sh.fields && Object.keys(sh.fields).length) facts.types.set(p.node.id.name, { ...sh, typeName: p.node.id.name });
      }
    },

    TSInterfaceDeclaration(p: NodePath<any>) {
      facts.types.set(p.node.id.name, { ...tsTypeToShape(p.node), typeName: p.node.id.name });
    },
    TSTypeAliasDeclaration(p: NodePath<any>) {
      facts.types.set(p.node.id.name, { ...tsTypeToShape(p.node.typeAnnotation), typeName: p.node.id.name });
    },

    ReturnStatement(p: NodePath<any>) {
      if (!p.node.argument) return;
      getFn(enclosingFn(p)).returns.push(valueOf(p.get('argument') as any));
    },
    ArrowFunctionExpression(p: NodePath<any>) {
      if (p.node.body.type !== 'BlockStatement') getFn(fnId(p), p).returns.push(valueOf(p.get('body') as any));
    },

    // ---------- exports
    ExportNamedDeclaration(p: NodePath<any>) {
      const n = p.node;
      if (n.source) {
        for (const s of n.specifiers) {
          const exported = s.exported.name ?? s.exported.value;
          if (s.type === 'ExportNamespaceSpecifier') facts.exports.set(exported, { t: 'ref', file, source: n.source.value, imported: '*' });
          else facts.exports.set(exported, { t: 'ref', file, source: n.source.value, imported: s.local.name ?? s.local.value });
        }
        return;
      }
      const d = p.get('declaration') as NodePath<any>;
      if (d.node) {
        if ((d.isFunctionDeclaration() || d.isClassDeclaration()) && d.node.id) facts.exports.set(d.node.id.name, valueOf(d));
        else if (d.isVariableDeclaration()) {
          for (const dp of d.get('declarations') as NodePath<any>[]) {
            if (dp.node.id.type === 'Identifier') facts.exports.set(dp.node.id.name, dp.node.init ? valueOf(dp.get('init') as any) : { t: 'dyn', hint: dp.node.id.name });
          }
        } else if (d.isTSEnumDeclaration()) facts.exports.set(d.node.id.name, { t: 'type', name: d.node.id.name, file });
      }
      for (const sp of p.get('specifiers') as NodePath<any>[]) {
        const s = sp.node;
        if (s.type !== 'ExportSpecifier') continue;
        const exported = s.exported.name ?? s.exported.value;
        facts.exports.set(exported, valueOf(sp.get('local') as any));
      }
    },
    ExportDefaultDeclaration(p: NodePath<any>) {
      facts.exports.set('default', valueOf(p.get('declaration') as any));
    },
    ExportAllDeclaration(p: NodePath<any>) {
      facts.stars.push(p.node.source.value);
    },

    AssignmentExpression(p: NodePath<any>) {
      const left = p.node.left;
      if (left.type !== 'MemberExpression') return;
      // module.exports = X / module.exports.a = X / exports.a = X
      if (isModuleExports(left)) {
        facts.exports.set('*cjs', valueOf(p.get('right') as any));
        return;
      }
      if (isModuleExports(left.object) || (left.object.type === 'Identifier' && left.object.name === 'exports' && !p.scope.getBinding('exports'))) {
        const k = memberKey(left);
        if (k) facts.exports.set(k, valueOf(p.get('right') as any));
        return;
      }
      // this.x = expr (class fields)
      if (left.object.type === 'ThisExpression') {
        const cls = enclosingClass(p);
        const k = memberKey(left);
        if (cls && k) {
          const cf = getClass(cls);
          const v = valueOf(p.get('right') as any);
          if (v.t === 'param') {
            const fn = facts.fns.get(v.fn);
            const pt = fn?.paramTypes[v.i];
            cf.fields[k] = pt && (pt.t === 'inst' || pt.t === 'obj') ? pt : v;
          } else if (!cf.fields[k] || cf.fields[k].t === 'dyn') cf.fields[k] = v;
        }
        return;
      }
      // koa: ctx.body = X
      const k = memberKey(left);
      if (k === 'body') {
        const obj = valueOf(p.get('left.object') as any);
        if (obj.t === 'param' && (!obj.path || (obj.path.length === 1 && obj.path[0] === 'response'))) addOp(p, { k: 'respond', res: { ...obj, path: undefined }, body: valueOf(p.get('right') as any), style: 'koa' });
      }
    },

    VariableDeclarator(p: NodePath<any>) {
      const id = p.node.id;
      if (id.type !== 'ObjectPattern' || !p.node.init) return;
      const v = valueOf(p.get('init') as any);
      if (v.t !== 'param') return;
      for (const leaf of leafPaths(id)) {
        const full = [...(v.path ?? []), ...leaf];
        if (/^(body|payload|query|params|request)$/.test(full[0]) && full.length > 1) addOp(p, { k: 'reads', sym: { ...v, path: full } });
      }
    },

    MemberExpression(p: NodePath<any>) {
      // only outermost member of a chain; skip callee positions
      if (p.parentPath?.isMemberExpression() && p.parentPath.node.object === p.node) return;
      if (p.parentPath?.isCallExpression() && p.parentPath.node.callee === p.node) return;
      if (p.parentPath?.isAssignmentExpression() && p.parentPath.node.left === p.node) return;
      if (p.parentPath?.isVariableDeclarator() && p.parentPath.node.init === p.node && p.parentPath.node.id.type === 'ObjectPattern') return;
      const v = valueOf(p);
      if (v.t === 'param' && v.path && v.path.length > 1 && /^(body|payload|query|params|request)$/.test(v.path[0])) addOp(p, { k: 'reads', sym: v });
    },

    TaggedTemplateExpression(p: NodePath<any>) {
      const tag = p.node.tag;
      const name = tag.type === 'Identifier' ? tag.name : tag.type === 'MemberExpression' ? memberKey(tag) : '';
      if (!name || !/^(sql|SQL|\$queryRaw|\$executeRaw|query|db|pool|pg|postgres)$/.test(name)) return;
      const q = valueOf(p.get('quasi') as any);
      addOp(p, { k: 'sql', sql: q });
    },

    NewExpression(p: NodePath<any>) {
      const n = p.node;
      const cname = calleeName(n.callee);
      const args = p.get('arguments') as NodePath<any>[];
      if (Object.hasOwn(AWS_V3, cname)) {
        const [svc, action] = AWS_V3[cname];
        const input = args[0] ? valueOf(args[0]) : { t: 'null' as const };
        if (action === 'ReceiveMessage') {
          const fid = enclosingFn(p);
          facts.consumers.push({ k: 'sqs', queue: member(input, 'QueueUrl'), handler: { t: 'fn', id: fid }, loc: loc(n), fn: fid });
          facts.handlerRefs.push({ t: 'fn', id: fid });
        } else addOp(p, { k: 'aws', svc, action, input, v3: true });
        return;
      }
      if (cname === 'Upload' && args[0]) {
        const o = valueOf(args[0]);
        if (o.t === 'obj' && o.fields.params) addOp(p, { k: 'aws', svc: 's3', action: 'PutObject', input: o.fields.params, v3: true });
      }
      const v = valueOf(p);
      if (v.t === 'obj') {
        const kind = v.fields.__kind?.t === 'str' ? v.fields.__kind.v : '';
        if (kind === 'ws-client') addOp(p, { k: 'ws-connect', lib: 'ws', url: v.fields.url });
        if (kind === 'ws-server') facts.consumers.push({ k: 'ws-server', id: (v.fields.__id as any).v, path: v.fields.path, port: v.fields.port, loc: loc(n), fn: enclosingFn(p) });
      }
      // constructor call edge
      const cs = valueOf(p.get('callee') as any);
      if (cs.t === 'class' || cs.t === 'ref') getFn(enclosingFn(p)).calls.push({ target: member(cs.t === 'class' ? cs : { t: 'inst', cls: cs }, 'constructor'), args: args.map((a) => valueOf(a)), loc: loc(n) });
    },

    CallExpression(p: NodePath<any>) {
      handleCall(p);
    },
    OptionalCallExpression(p: NodePath<any>) {
      handleCall(p);
    },
  });

  // ---------- Nest controllers (decorator routes)
  for (const [cid, cf] of facts.classes) {
    const ctrl = cf.decorators.find((d) => d.name === 'Controller');
    if (!ctrl) continue;
    const a0 = ctrl.args[0];
    const prefix: Sym = a0?.t === 'obj' ? a0.fields.path ?? { t: 'str', v: '' } : a0 ?? { t: 'str', v: '' };
    for (const m of cf.methods) {
      const fid = `${cid}.${m}`;
      const f = facts.fns.get(fid);
      if (!f) continue;
      const d = f.decorators.find((x) => /^(Get|Post|Put|Patch|Delete|All|Options|Head)$/.test(x.name));
      if (!d) continue;
      const sub = d.args[0] ?? { t: 'str', v: '' };
      const bodyIdx = Object.entries(f.paramDecorators).find(([, v]) => v === 'Body')?.[0];
      facts.routes.push({
        method: d.name.toUpperCase(),
        path: { t: 'concat', parts: [{ t: 'str', v: '/' }, prefix, { t: 'str', v: '/' }, sub] },
        handlers: [{ t: 'fn', id: fid }],
        style: 'nest',
        certain: true,
        loc: f.loc,
        fn: fid,
        nestBody: bodyIdx !== undefined ? { index: Number(bodyIdx), type: f.paramTypes[Number(bodyIdx)] } : undefined,
      });
      facts.handlerRefs.push({ t: 'fn', id: fid });
    }
  }
  // Sequelize: Model.init(attrs, { tableName })
  return facts;

  // =========================================================== call handling
  function handleCall(p: NodePath<any>) {
    const n = p.node;
    const callee = p.get('callee') as NodePath<any>;
    const args = p.get('arguments') as NodePath<any>[];
    const fid = enclosingFn(p);
    const fn = getFn(fid);
    const isMember = n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression';
    const m = isMember ? memberKey(n.callee) ?? '' : n.callee.type === 'Identifier' ? n.callee.name : '';
    const recvPath = isMember ? (callee.get('object') as NodePath<any>) : undefined;
    const recv = recvPath ? valueOf(recvPath) : undefined;
    const cs = valueOf(callee);
    const argv = () => args.map((a) => (a.isSpreadElement() ? valueOf(a.get('argument') as any) : valueOf(a)));
    let registered = false; // callee registers handlers (route/consumer) → don't add callback edges

    const recvKind = recv?.t === 'obj' && recv.fields.__kind?.t === 'str' ? recv.fields.__kind.v : recv?.t === 'ext' ? `ext:${extKey(recv)}` : '';
    const extK = cs.t === 'ext' ? extKey(cs) : '';

    // ---------------- Sequelize Model.init(attrs, { tableName })
    if (m === 'init' && recv?.t === 'class' && args[1]) {
      const opts = valueOf(args[1]);
      const cls = facts.classes.get(recv.id);
      if (cls) cls.table = opts.t === 'obj' ? opts.fields.tableName ?? { t: 'str', v: plural(cls.name) } : { t: 'str', v: plural(cls.name) };
    }

    // ---------------- HTTP clients
    if (extK === 'fetch' || extK === 'node-fetch' || extK === 'cross-fetch' || extK === 'isomorphic-fetch' || extK === 'undici.fetch' || extK === 'ofetch' || extK === 'ofetch.ofetch' || extK === 'ofetch.$fetch' || (n.callee.type === 'Identifier' && (m === '$fetch' || m === 'ofetch') && !p.scope.getBinding(m)) || (isMember && m === 'fetch' && n.callee.object.type === 'Identifier' && ['window', 'globalThis', 'self', 'global'].includes(n.callee.object.name))) {
      const opts = args[1] ? valueOf(args[1]) : undefined;
      addHttp(p, 'fetch', args[0] ? valueOf(args[0]) : S0, opts?.t === 'obj' ? opts.fields.method ?? STR('GET') : STR('GET'), opts?.t === 'obj' ? opts.fields.body : undefined, 'none');
    } else if (extK === 'undici.request') {
      const opts = args[1] ? valueOf(args[1]) : undefined;
      addHttp(p, 'undici', args[0] ? valueOf(args[0]) : S0, opts?.t === 'obj' ? opts.fields.method ?? STR('GET') : STR('GET'), opts?.t === 'obj' ? opts.fields.body : undefined, 'none');
    } else if (extK === 'axios' || extK === 'axios.default' || extK === 'axios.request' || extK === 'got' || extK === 'got.default' || extK === 'request' || extK === 'ky') {
      // axios(config) | axios(url, config) | got(url, opts)
      const a0 = args[0] ? valueOf(args[0]) : S0;
      const a1 = args[1] ? valueOf(args[1]) : undefined;
      const cfg = a0.t === 'obj' ? a0 : a1?.t === 'obj' ? a1 : undefined;
      const url = a0.t === 'obj' ? a0.fields.url ?? a0.fields.uri ?? S0 : a0;
      addHttp(p, extK.split('.')[0], url, cfg?.fields.method ?? STR('GET'), cfg?.fields.data ?? cfg?.fields.json ?? cfg?.fields.body, 'none', cfg?.fields.baseURL ?? cfg?.fields.prefixUrl);
    } else if (/^(http|https)\.(request|get)$/.test(extK)) {
      const a0 = args[0] ? valueOf(args[0]) : S0;
      if (a0.t === 'obj') {
        const f = a0.fields;
        const proto = extK.startsWith('https') ? 'https://' : 'http://';
        const url: Sym = { t: 'concat', parts: [STR(proto), f.hostname ?? f.host ?? STR('{host}'), ...(f.port ? [STR(':'), f.port] : []), f.path ?? STR('/')] };
        addHttp(p, 'http', url, f.method ?? STR(extK.endsWith('get') ? 'GET' : 'GET'), undefined, 'none');
      } else addHttp(p, 'http', a0, STR('GET'), undefined, 'none');
    } else if (extK === 'needle') {
      addHttp(p, 'needle', args[1] ? valueOf(args[1]) : S0, args[0] ? valueOf(args[0]) : STR('GET'), args[2] ? valueOf(args[2]) : undefined, 'none');
    } else if (isMember && (HTTP_METHODS.has(m) || (m === 'del' && recvKind.startsWith('ext:superagent')))) {
      const isRouterRecv = recvKind === 'router' || recvKind === 'ext:express' || recvKind === 'ext:fastify';
      const knownClient = recvKind === 'axios' || /^ext:(axios|got|superagent|ky|needle|request|ofetch)/.test(recvKind);
      const handlerArgs = args.slice(1).filter((a) => isHandlerish(a));
      const a0 = args[0];
      const a0v = a0 ? valueOf(a0) : undefined;
      const pathLike = !!a0 && recvKind !== 'map' && (looksLikePath(a0v) || (a0v?.t === 'param' && !!recv && (recv.t === 'param' || recvKind === 'axios')));
      // route registration?
      if (!knownClient && ROUTE_METHODS.has(m) && args.length >= 2 && (isRouterRecv || handlerArgs.length > 0 || (args.length >= 2 && args.slice(1).some((a) => a.isIdentifier() || a.isMemberExpression() || a.isCallExpression())))) {
        const certain = isRouterRecv || handlerArgs.some((a) => isFnLike(a));
        const handlers = collectHandlers(args.slice(1));
        facts.routes.push({ recv, method: m === 'del' ? 'DELETE' : m.toUpperCase(), path: a0 ? valueOf(a0) : STR('/'), handlers, style: styleOf(recv), certain, loc: loc(n), fn: fid });
        handlers.forEach((h) => facts.handlerRefs.push(h));
        registered = true;
        if (!certain && pathLike) {
          // ambiguous (e.g. api.post('/x', payload)) — also record as potential http client call; resolved globally
          addHttp(p, 'client', valueOf(a0), STR(m.toUpperCase()), ['post', 'put', 'patch'].includes(m) && args[1] ? valueOf(args[1]) : undefined, 'client', member(recv!, 'baseURL'), recv);
        }
      } else if (!isRouterRecv && a0 && (knownClient || pathLike || m === 'request')) {
        const lib = recvKind.startsWith('ext:') ? recvKind.slice(4).split('.')[0] : recvKind === 'axios' ? 'axios' : 'client';
        let url = valueOf(a0);
        let method: Sym = STR(m.toUpperCase());
        let body: Sym | undefined;
        if (m === 'request' && url.t === 'obj') {
          const cfg = url;
          url = cfg.fields.url ?? S0;
          method = cfg.fields.method ?? STR('GET');
          body = cfg.fields.data ?? cfg.fields.body ?? cfg.fields.json;
        } else if (['post', 'put', 'patch'].includes(m)) {
          const a1 = args[1] ? valueOf(args[1]) : undefined;
          body = lib === 'got' || lib === 'ky' ? (a1?.t === 'obj' ? a1.fields.json ?? a1.fields.body : undefined) : a1;
          if (lib === 'superagent') body = superagentSend(p);
        }
        const isRedisLike = REDIS_CMDS.has(m) && /redis|cache|kv/i.test(hintOf(n.callee.object));
        if (!isRedisLike) addHttp(p, lib, url, method, body, knownClient ? 'none' : 'client', recv && !recvKind.startsWith('ext:') ? member(recv, 'baseURL') : undefined, recv, typeArg(n));
      }
    }

    // ---------------- WebSocket / socket.io
    if (extK.startsWith('socket.io-client')) {
      addOp(p, { k: 'ws-connect', lib: 'socket.io', url: args[0] ? valueOf(args[0]) : STR('/') });
    }
    if (isMember && m === 'emit' && args[0] && recv && recvKind !== 'sio-server') {
      addOp(p, { k: 'ws-emit', recv, event: valueOf(args[0]), payload: args[1] ? valueOf(args[1]) : undefined });
    }
    if (isMember && m === 'send' && recvKind === 'ws-client' && args[0]) {
      const pl = valueOf(args[0]);
      const inner = pl.t === 'json' ? pl.of : pl;
      addOp(p, { k: 'ws-emit', recv: recv!, event: inner.t === 'obj' ? inner.fields.type ?? inner.fields.event ?? inner.fields.action ?? STR('message') : STR('message'), payload: inner });
    }
    if (isMember && m === 'on' && args.length >= 2) {
      const ev = strArg(args[0]);
      if (ev === 'connection' && recv && (recvKind === 'ws-server' || recvKind === 'sio-server' || recv.t === 'ref' || recv.t === 'inst')) {
        const h = valueOf(args[1]);
        facts.consumers.push({ k: 'ws-connection', recv, handler: h, loc: loc(n), fn: fid });
        facts.handlerRefs.push(h);
        registered = true;
      } else if (ev && !SIO_BUILTIN.has(ev) && recvKind !== 'redis' && !/^ext:/.test(recvKind) && (isFnLike(args[1]) || args[1].isIdentifier() || args[1].isMemberExpression())) {
        const h = valueOf(args[1]);
        facts.consumers.push({ k: 'sio-event', event: ev, handler: h, loc: loc(n), fn: fid });
        facts.handlerRefs.push(h);
        registered = true;
      }
    }

    // ---------------- AWS SDK v2 style + sqs-consumer
    if (isMember && Object.hasOwn(AWS_V2, m) && args[0]) {
      const [svc, action, key] = AWS_V2[m];
      const input = valueOf(args[0]);
      const ok = input.t === 'obj' ? key in input.fields : input.t === 'param' || input.t === 'ref';
      const dynamoVerb = svc === 'dynamodb' && ['put', 'get', 'update', 'delete', 'query', 'scan'].includes(m);
      if (ok && !(dynamoVerb && input.t !== 'obj')) {
        if (action === 'ReceiveMessage') {
          facts.consumers.push({ k: 'sqs', queue: member(input, 'QueueUrl'), handler: { t: 'fn', id: fid }, loc: loc(n), fn: fid });
          facts.handlerRefs.push({ t: 'fn', id: fid });
        } else addOp(p, { k: 'aws', svc, action, input, v3: false, needKey: key });
      }
    }
    if ((extK === 'sqs-consumer.Consumer.create' || (isMember && m === 'create' && recv?.t === 'ext' && recv.mod === 'sqs-consumer')) && args[0]) {
      const o = valueOf(args[0]);
      if (o.t === 'obj') {
        const h = o.fields.handleMessage ?? o.fields.handleMessageBatch;
        if (h) {
          facts.consumers.push({ k: 'sqs', queue: o.fields.queueUrl ?? S0, handler: h, loc: loc(n), fn: fid });
          facts.handlerRefs.push(h);
          registered = true;
        }
      }
    }

    // ---------------- SQL
    if (isMember && SQL_METHODS.has(m) && args[0] && recvKind !== 'redis' && recvKind !== 'router' && !recvKind.startsWith('ext:axios')) {
      let q = valueOf(args[0]);
      if (q.t === 'obj') q = q.fields.text ?? q.fields.sql ?? S0;
      if (q.t !== 'obj' && q.t !== 'fn') addOp(p, { k: 'sql', sql: q, recv });
    }

    // ---------------- knex: db('table')... / knex.from('t') / .into('t') / .table('t')
    if (!isMember && args[0] && n.callee.type === 'Identifier' && (cs.t === 'obj' && cs.fields.__kind?.t === 'str' && cs.fields.__kind.v === 'knex' || ((cs.t === 'ref' || cs.t === 'param' || cs.t === 'dyn') && /^(knex|db|trx|k|database|pg)$/i.test(m)))) {
      const tv = valueOf(args[0]);
      if (tv.t === 'str' || tv.t === 'concat' || tv.t === 'env' || tv.t === 'ref') addOp(p, { k: 'knex', recv: cs, table: tv, op: knexOp(p) });
    }
    if (isMember && (m === 'from' || m === 'into' || m === 'table' || m === 'withSchema') && args[0] && (args[0].isStringLiteral() || args[0].isTemplateLiteral()) && recv && recvKind !== 'router' && /knex|db|trx|query|builder|qb/i.test(hintOf(n.callee.object))) {
      addOp(p, { k: 'knex', recv, table: valueOf(args[0]), op: knexOp(p) });
    }

    // ---------------- ORM / Mongo store ops
    if (isMember && STORE_METHODS.has(m) && recv && recvKind !== 'router' && recvKind !== 'axios' && !recvKind.startsWith('ext:') && recvKind !== 'redis') {
      if (!(m === 'get' || m === 'delete' || m === 'update') || recvKind === 'model' || recvKind === 'repo' || recvKind === 'mongo-coll' || recv.t === 'class' || recv.t === 'inst' || recv.t === 'ref') {
        addOp(p, { k: 'store', recv, m, data: args[0] ? valueOf(args[0]) : undefined });
      }
    }
    // prisma.user.findMany()
    if (isMember && PRISMA_METHODS.has(m) && n.callee.object.type === 'MemberExpression') {
      const model = memberKey(n.callee.object);
      const client = valueOf(callee.get('object.object') as any);
      if (model && !model.startsWith('$')) addOp(p, { k: 'prisma', client, model, op: m, data: args[0] ? valueOf(args[0]) : undefined });
    }

    // ---------------- Redis
    if (isMember && REDIS_CMDS.has(m.toLowerCase()) && args[0] && recvKind !== 'router' && recvKind !== 'axios' && !recvKind.startsWith('ext:axios') && recvKind !== 'mongo-coll' && recvKind !== 'model' && recvKind !== 'repo') {
      const hint = hintOf(n.callee.object);
      const hinted = recvKind === 'redis' || /redis|valkey/i.test(hint) || /^(cache|kv|cacheClient|cacheStore)$/i.test(hint);
      const key = valueOf(args[0]);
      if (recvKind !== 'map' && (hinted || recv?.t === 'ref' || recv?.t === 'inst' || recv?.t === 'param')) addOp(p, { k: 'redis', recv: recv!, cmd: m.toUpperCase(), key, hinted });
    }

    // ---------------- Elasticsearch
    if (isMember && ES_METHODS.has(m) && args[0]) {
      const o = valueOf(args[0]);
      if (o.t === 'obj' && o.fields.index) addOp(p, { k: 'es', index: o.fields.index, op: m, body: o.fields.body ?? o.fields.document ?? o.fields.query });
    }

    // ---------------- responses: res.json(x) / res.status(201).send(x) / reply.code(200).send(x)
    if (isMember && ['json', 'send', 'jsonp', 'end'].includes(m)) {
      let obj: any = n.callee.object;
      let objPath = callee.get('object') as NodePath<any>;
      let status: number | undefined;
      while (obj.type === 'CallExpression' && obj.callee.type === 'MemberExpression' && ['status', 'code', 'set', 'header', 'type', 'setHeader', 'headers'].includes(memberKey(obj.callee) ?? '')) {
        if (['status', 'code'].includes(memberKey(obj.callee) ?? '') && obj.arguments[0]?.type === 'NumericLiteral') status = obj.arguments[0].value;
        objPath = objPath.get('callee.object') as NodePath<any>;
        obj = obj.callee.object;
      }
      const r = valueOf(objPath);
      if (r.t === 'param' && !r.path && (args[0] || m === 'end')) addOp(p, { k: 'respond', res: r, status, body: args[0] ? valueOf(args[0]) : undefined, style: 'express' });
    }
    if (isMember && ['sendStatus'].includes(m)) {
      /* status-only responses ignored */
    }

    // ---------------- validation: schema.parse(req.body) / schema.validate(req.body)
    if (isMember && ['parse', 'safeParse', 'parseAsync', 'validate', 'validateAsync', 'validateSync', 'cast'].includes(m) && args[0]) {
      const target = valueOf(args[0]);
      if (target.t === 'param') addOp(p, { k: 'validate', target, schema: recv! });
    }
    if (n.callee.type === 'Identifier' && ['validate', 'plainToInstance', 'plainToClass'].includes(m) && args.length >= 2) {
      const target = valueOf(args[1]);
      if (target.t === 'param') addOp(p, { k: 'validate', target, schema: { ...valueOf(args[0]) } });
    }

    // ---------------- routing structure
    if (isMember && (m === 'use' || m === 'register') && args.length) {
      let prefix: Sym | undefined;
      let rest = args;
      const s0 = valueOf(args[0]);
      if (m === 'use' && looksLikePath(s0)) {
        prefix = s0;
        rest = args.slice(1);
      }
      if (m === 'register' && args[1]) {
        const o = valueOf(args[1]);
        if (o.t === 'obj' && o.fields.prefix) prefix = o.fields.prefix;
        rest = [args[0]];
      }
      for (const c of rest) {
        const child = valueOf(c.isSpreadElement() ? (c.get('argument') as any) : c);
        facts.mounts.push({ via: m as 'use' | 'register', parent: recv!, prefix, child, loc: loc(n) });
      }
      registered = true;
      // mounted children are invoked by the framework; middleware fns behave like handlers
    }
    if (isMember && m === 'route' && args[0]) {
      const o = valueOf(args[0]);
      const defs = o.t === 'arr' && o.item ? [o.item] : [o];
      for (const d of defs) {
        if (d.t !== 'obj') continue;
        const pathS = d.fields.url ?? d.fields.path;
        const meth = d.fields.method;
        let h = d.fields.handler ?? (d.fields.options?.t === 'obj' ? d.fields.options.fields.handler : undefined) ?? (d.fields.config?.t === 'obj' ? d.fields.config.fields.handler : undefined);
        if (!pathS || !h) continue;
        const methods = meth?.t === 'str' ? [meth.v] : meth?.t === 'arr' && meth.item?.t === 'str' ? [meth.item.v] : ['ALL'];
        const pre = d.fields.preHandler ? [d.fields.preHandler] : [];
        for (const mm of methods) facts.routes.push({ recv, method: mm.toUpperCase() === '*' ? 'ALL' : mm.toUpperCase(), path: pathS, handlers: [...pre, h], style: recvKind === 'router' && (recv as any).fields.fw?.v === 'hapi' ? 'hapi' : styleOf(recv), certain: true, loc: loc(n), fn: fid });
        facts.handlerRefs.push(h);
      }
      registered = true;
    }
    if (isMember && m === 'setGlobalPrefix' && args[0]) facts.globalPrefixes.push(valueOf(args[0]));
    if (isMember && m === 'listen' && args[0] && recv) {
      const a0 = valueOf(args[0]);
      const port = a0.t === 'obj' ? a0.fields.port ?? S0 : a0;
      facts.listens.push({ recv, port, loc: loc(n) });
    }
    // express app.route('/x').get(h)
    if (isMember && ROUTE_METHODS.has(m) && n.callee.object.type === 'CallExpression') {
      let o: any = n.callee.object;
      let op = callee.get('object') as NodePath<any>;
      while (o?.type === 'CallExpression' && o.callee.type === 'MemberExpression' && memberKey(o.callee) !== 'route') {
        op = op.get('callee.object') as NodePath<any>;
        o = o.callee.object;
      }
      if (o?.type === 'CallExpression' && o.callee.type === 'MemberExpression' && memberKey(o.callee) === 'route' && o.arguments[0]) {
        const handlers = collectHandlers(args);
        facts.routes.push({ recv: valueOf(op.get('callee.object') as any), method: m.toUpperCase(), path: valueOf((op.get('arguments') as NodePath<any>[])[0]), handlers, style: 'express', certain: true, loc: loc(n), fn: fid });
        handlers.forEach((h) => facts.handlerRefs.push(h));
        registered = true;
      }
    }

    // ---------------- generic call site + callbacks
    if (cs.t === 'fn' || cs.t === 'ref' || cs.t === 'inst' || cs.t === 'param' || (cs.t === 'dyn' && false)) {
      fn.calls.push({ target: cs, args: argv(), loc: loc(n) });
    }
    if (!registered) {
      for (const a of args) {
        if (isFnLike(a)) fn.calls.push({ target: { t: 'fn', id: fnId(a) }, args: [], loc: loc(a.node), callback: true });
        else if (a.isIdentifier() || a.isMemberExpression()) {
          const v = valueOf(a);
          if (v.t === 'fn' || v.t === 'ref' || (v.t === 'inst' && v.path?.length)) fn.calls.push({ target: v, args: [], loc: loc(a.node), callback: true });
        }
      }
    }
  }

  function addHttp(p: NodePath<any>, lib: string, url: Sym, method: Sym, body: Sym | undefined, guard: 'none' | 'client', base?: Sym, recv?: Sym, resTypeNode?: any) {
    addOp(p, { k: 'http', lib, url, method, body, base, recv, guard, resType: resTypeNode ? typeSym(resTypeNode, p) : undefined });
  }

  function superagentSend(p: NodePath<any>): Sym | undefined {
    let q: NodePath<any> | null = p;
    for (let i = 0; i < 8 && q; i++) {
      const par: NodePath<any> | null = q.parentPath;
      if (par?.isMemberExpression() && par.parentPath?.isCallExpression() && memberKey(par.node) === 'send') return valueOf((par.parentPath.get('arguments') as NodePath<any>[])[0]);
      q = par?.isMemberExpression() || par?.isCallExpression() ? par : null;
    }
    return undefined;
  }

  function knexOp(p: NodePath<any>): string {
    let q: NodePath<any> | null = p;
    for (let i = 0; i < 12 && q; i++) {
      const par: NodePath<any> | null = q.parentPath;
      if (par?.isMemberExpression()) {
        const k = memberKey(par.node) ?? '';
        if (/^(insert|update|del|delete|truncate|upsert|merge|increment|decrement)$/.test(k)) return k === 'del' ? 'DELETE' : k.toUpperCase();
      }
      q = par?.isMemberExpression() || par?.isCallExpression() || par?.isAwaitExpression() ? par : null;
    }
    return 'SELECT';
  }

  function collectHandlers(args: NodePath<any>[]): Sym[] {
    const out: Sym[] = [];
    for (const a of args) {
      if (a.isCallExpression()) {
        // asyncHandler(fn) / wrap(ctrl.create) → unwrap; validate(schema) middleware factories → the factory return
        const inner = (a.get('arguments') as NodePath<any>[]).filter((x) => isFnLike(x) || x.isIdentifier() || x.isMemberExpression());
        const v = valueOf(a.get('callee') as any);
        if (v.t === 'fn' || v.t === 'ref' || v.t === 'inst') out.push(v); // middleware factory itself
        for (const i of inner) {
          const iv = valueOf(i);
          if (iv.t === 'fn' || iv.t === 'ref' || iv.t === 'inst') out.push(iv);
        }
      } else if (a.isArrayExpression()) {
        out.push(...collectHandlers(a.get('elements') as NodePath<any>[]));
      } else {
        const v = valueOf(a);
        if (v.t === 'fn' || v.t === 'ref' || v.t === 'inst' || v.t === 'param') out.push(v);
        else if (v.t === 'obj' && v.fields.handler) out.push(v.fields.handler);
      }
    }
    return out;
  }

  function isHandlerish(a: NodePath<any>): boolean {
    if (isFnLike(a)) return true;
    if (a.isIdentifier()) {
      const b = a.scope.getBinding(a.node.name);
      const bp = b?.path as NodePath<any> | undefined;
      if (bp?.isFunctionDeclaration()) return true;
      if (bp?.isVariableDeclarator() && bp.node.init && /Function/.test(bp.node.init.type)) return true;
    }
    return false;
  }

  function styleOf(recv: Sym | undefined): RouteFacts['style'] {
    if (recv?.t === 'obj' && recv.fields.fw?.t === 'str') return recv.fields.fw.v as any;
    return 'express';
  }

  function getClass(p: NodePath<any>): ClassFacts {
    const id = fnId(p);
    let c = facts.classes.get(id);
    if (!c) {
      c = { id, name: p.node.id?.name ?? 'anon', file, fields: {}, methods: [], decorators: [], loc: loc(p.node) };
      facts.classes.set(id, c);
    }
    return c;
  }
}

// ------------------------------------------------------------------ small utils
const STR = (v: string): Sym => ({ t: 'str', v });
const S0: Sym = { t: 'dyn', hint: 'x' };

export function extKey(s: Extract<Sym, { t: 'ext' }>): string {
  return [s.mod, ...s.path].join('.');
}

function normEnv(s: Sym): Sym {
  if (s.t === 'ext' && s.mod === '__env' && s.path.length === 1) return { t: 'env', name: s.path[0] };
  return s;
}

function isProcessEnv(n: any): boolean {
  return n?.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'process' && memberKey(n) === 'env';
}

function isModuleExports(n: any): boolean {
  return n?.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'module' && memberKey(n) === 'exports';
}

export function memberKey(n: any): string | undefined {
  if (!n) return undefined;
  if (!n.computed) return n.property?.name ?? n.property?.id?.name;
  if (n.property?.type === 'StringLiteral') return n.property.value;
  if (n.property?.type === 'NumericLiteral') return String(n.property.value);
  return undefined;
}

function propKey(n: any): string | undefined {
  if (n.computed) return n.key?.type === 'StringLiteral' ? n.key.value : undefined;
  return n.key?.name ?? n.key?.value?.toString();
}

function paramName(p: any): string {
  if (!p) return '?';
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'AssignmentPattern') return paramName(p.left);
  if (p.type === 'TSParameterProperty') return paramName(p.parameter);
  if (p.type === 'RestElement') return '...' + paramName(p.argument);
  if (p.type === 'ObjectPattern') return '{…}';
  return '?';
}

function hintOf(n: any): string {
  if (!n) return 'x';
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') return memberKey(n) ?? hintOf(n.object);
  if (n.type === 'CallExpression') return hintOf(n.callee);
  if (n.type === 'ThisExpression') return 'this';
  return 'x';
}

function contains(root: any, target: any): boolean {
  if (root === target) return true;
  if (!root || typeof root !== 'object') return false;
  for (const k of ['left', 'argument', 'parameter', 'properties', 'elements', 'value', 'key']) {
    const v = root[k];
    if (Array.isArray(v)) {
      if (v.some((x) => contains(x, target))) return true;
    } else if (v && typeof v === 'object' && contains(v, target)) return true;
  }
  return false;
}

/** Path of property keys from a destructuring pattern root to the target identifier. */
function patternPath(pat: any, target: any): string[] | null {
  if (!pat) return null;
  if (pat === target) return [];
  switch (pat.type) {
    case 'Identifier':
      return null;
    case 'AssignmentPattern':
      return patternPath(pat.left, target);
    case 'TSParameterProperty':
      return patternPath(pat.parameter, target);
    case 'RestElement':
      return patternPath(pat.argument, target);
    case 'ObjectPattern':
      for (const prop of pat.properties) {
        if (prop.type === 'RestElement') {
          const r = patternPath(prop.argument, target);
          if (r) return r;
          continue;
        }
        const k = propKey(prop);
        const r = patternPath(prop.value, target);
        if (r && k !== undefined) return [k, ...r];
      }
      return null;
    case 'ArrayPattern':
      for (let i = 0; i < pat.elements.length; i++) {
        const r = patternPath(pat.elements[i], target);
        if (r) return [String(i), ...r];
      }
      return null;
  }
  return null;
}

function leafPaths(pat: any, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  if (!pat) return out;
  if (pat.type === 'Identifier') return [prefix];
  if (pat.type === 'AssignmentPattern') return leafPaths(pat.left, prefix);
  if (pat.type === 'ObjectPattern') {
    for (const prop of pat.properties) {
      if (prop.type === 'RestElement') continue;
      const k = propKey(prop);
      if (k === undefined) continue;
      out.push(...leafPaths(prop.value, [...prefix, k]));
    }
  }
  return out;
}

function looksLikePath(s: Sym | undefined): boolean {
  if (!s) return false;
  if (s.t === 'str') return /^(\/|https?:\/\/|wss?:\/\/)/.test(s.v) || /^[\w-]+\/[\w-]/.test(s.v);
  if (s.t === 'concat') return looksLikePath(s.parts[0]) || (s.parts.length > 1 && s.parts[0].t !== 'str' && s.parts[1].t === 'str' && s.parts[1].v.startsWith('/'));
  if (s.t === 'env' || s.t === 'ref') return true;
  if (s.t === 'alt') return s.opts.some(looksLikePath);
  return false;
}

export function plural(name: string): string {
  const n = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(n)) return n + 'es';
  if (/[^aeiou]y$/.test(n)) return n.slice(0, -1) + 'ies';
  return n + 's';
}
