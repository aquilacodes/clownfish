import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/core/scan.ts';
import { serialize, parseMap } from '../src/core/emit.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/shop');
const map = await scan(root, { workers: 0 });
const has = (from: string, to: string, extra: (e: (typeof map.edges)[number]) => boolean = () => true) => map.edges.some((e) => e.from === from && e.to === to && extra(e));
const edge = (from: string, to: string) => map.edges.find((e) => e.from === from && e.to === to);

test('discovers the fixture packages', () => {
  const names = map.services.map((s) => s.name).sort();
  assert.deepEqual(names, ['@shop/http-client', 'gateway', 'inventory-lambda', 'notifications-worker', 'orders-service', 'realtime-service', 'users-service', 'web']);
  assert.equal(map.services.find((s) => s.name === 'web')?.kind, 'frontend');
});

test('frontend → gateway through the nginx proxy, and socket.io emit', () => {
  assert.ok(has('entry:web', 'ep:gateway:POST /api/orders', (e) => e.request?.fields?.userId !== undefined));
  assert.ok(has('entry:web', 'ep:gateway:GET /api/orders'));
  assert.ok(has('entry:web', 'ep:realtime-service:EVENT chat:message'));
  assert.ok(has('entry:web', 'ep:realtime-service:WS /socket.io'));
});

test('gateway → services via router mounts, config env and a shared client package', () => {
  assert.ok(has('ep:gateway:POST /api/orders', 'ep:orders-service:POST /orders', (e) => e.confidence >= 0.9));
  assert.ok(has('ep:gateway:POST /api/orders', 'ep:users-service:GET /users/:id'));
  assert.ok(has('ep:gateway:POST /api/users/signup', 'ep:users-service:POST /users', (e) => Object.keys(e.request?.fields ?? {}).join() === 'email,name'));
  assert.ok(has('ep:gateway:GET /api/orders', 'ep:orders-service:GET /orders'));
});

test('NestJS controller + DI + TypeORM + redis + SNS/SQS', () => {
  const ep = map.nodes.find((n) => n.id === 'ep:orders-service:POST /orders');
  assert.deepEqual(Object.keys(ep?.request?.fields ?? {}).sort(), ['couponCode', 'items', 'userId']);
  assert.ok(has('ep:orders-service:POST /orders', 'sink:postgres:orders', (e) => e.operations?.includes('INSERT') ?? false));
  assert.ok(has('ep:orders-service:POST /orders', 'sink:redis:orders:user:{userId}'));
  assert.ok(has('ep:orders-service:POST /orders', 'topic:sns:order-events'));
  assert.ok(has('ep:orders-service:POST /orders', 'queue:sqs:email-jobs'));
  assert.deepEqual(edge('ep:orders-service:GET /orders', 'sink:redis:orders:user:{userId}')?.operations?.sort(), ['GET', 'SETEX']);
});

test('Koa router prefix, zod body, mongoose + redis', () => {
  const ep = map.nodes.find((n) => n.id === 'ep:users-service:POST /users');
  assert.equal(ep?.request?.fields?.email?.source, 'zod');
  assert.ok(ep?.request?.fields?.marketingOptIn?.optional);
  assert.ok(has('ep:users-service:POST /users', 'sink:mongo:users'));
  assert.ok(has('ep:users-service:GET /users/:id', 'sink:redis:user:{id}'));
});

test('messaging: SNS → SQS (terraform) → sqs-consumer → external/dynamo/s3/lambda', () => {
  assert.ok(has('topic:sns:order-events', 'queue:sqs:email-jobs'));
  assert.ok(has('queue:sqs:email-jobs', 'ep:notifications-worker:SQS email-jobs'));
  assert.ok(has('ep:notifications-worker:SQS email-jobs', 'ext:api.sendgrid.com'));
  assert.ok(has('ep:notifications-worker:SQS email-jobs', 'sink:dynamodb:email-log'));
  assert.ok(has('ep:notifications-worker:SQS email-jobs', 'sink:s3:email-archive'));
  assert.ok(has('ep:notifications-worker:SQS email-jobs', 'fn:lambda:reserve'));
});

test('serverless lambdas: http, sqs and sns events, DynamoDB v2 and EventBridge', () => {
  assert.ok(has('ep:inventory-lambda:GET /stock/:sku', 'fn:lambda:getStock'));
  assert.ok(has('topic:sns:order-events', 'fn:lambda:onOrderEvent'));
  assert.ok(has('fn:lambda:onOrderEvent', 'queue:sqs:inventory-reservations'));
  assert.ok(has('queue:sqs:inventory-reservations', 'fn:lambda:reserve'));
  assert.ok(has('fn:lambda:reserve', 'sink:dynamodb:inventory-lambda-stock'));
  assert.ok(has('fn:lambda:reserve', 'bus:eventbridge:shop-bus'));
});

test('websocket + socket.io servers, elasticsearch and prisma', () => {
  assert.ok(has('ep:realtime-service:EVENT chat:message', 'sink:elasticsearch:chat-messages'));
  assert.ok(map.edges.some((e) => e.from === 'ep:realtime-service:EVENT chat:message' && /:message$/.test(e.to)));
  assert.ok(map.edges.some((e) => e.from === 'ep:realtime-service:WS /ticks' && /:tick$/.test(e.to)));
});

test('flows run from callers to terminal stores', () => {
  assert.ok(map.flows.some((f) => f.join(' > ') === 'entry:web > ep:gateway:POST /api/orders > ep:orders-service:POST /orders > topic:sns:order-events > queue:sqs:email-jobs > ep:notifications-worker:SQS email-jobs > sink:dynamodb:email-log'));
  assert.equal(map.warnings.length, 0);
});

test('XML output round-trips losslessly', () => {
  const back = parseMap(serialize(map, 'xml'));
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(map)));
});
