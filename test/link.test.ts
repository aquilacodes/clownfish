import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrl, matchScore, normPath } from '../src/core/link.ts';
import { sqlTables, joinUrl } from '../src/core/program.ts';
import { queueName, arnName, refName } from '../src/core/config.ts';

test('parseUrl handles absolute, placeholder and relative URLs', () => {
  assert.deepEqual(parseUrl('http://orders-service:3001/orders?x=1'), { scheme: 'http', host: 'orders-service', port: 3001, path: '/orders' });
  assert.deepEqual(parseUrl('{API_URL}/users/{id}'), { host: '{API_URL}', port: undefined, path: '/users/{id}' });
  assert.deepEqual(parseUrl('/api/v1//orders/'), { path: '/api/v1/orders' });
  assert.equal(parseUrl('wss://rt.example.com/ws').scheme, 'wss');
});

test('matchScore prefers literal segments and supports params/placeholders', () => {
  assert.ok(matchScore('/users/:id', '/users/{id}') > 0);
  assert.ok(matchScore('/users/:id', '/users/42') > 0);
  assert.equal(matchScore('/users/:id', '/orders/42'), -1);
  assert.ok(matchScore('/orders', '/orders') > matchScore('/:x', '/orders'));
  assert.ok(matchScore('/files/*', '/files/a/b') >= 0);
  assert.equal(normPath('/a/b/'), '/a/b');
});

test('sqlTables extracts tables and operations', () => {
  assert.deepEqual(sqlTables('SELECT o.*, p.name FROM orders o JOIN products p ON o.product_id = p.id').map((t) => t.table).sort(), ['orders', 'products']);
  assert.deepEqual(sqlTables('INSERT INTO audit_logs (a) VALUES ($1)'), [{ table: 'audit_logs', op: 'INSERT' }]);
  assert.equal(sqlTables('UPDATE sankalpa_details SET x = 1 WHERE id = {id}')[0].op, 'UPDATE');
});

test('AWS name helpers', () => {
  assert.equal(queueName('https://sqs.us-east-1.amazonaws.com/000/email-jobs'), 'email-jobs');
  assert.equal(arnName('arn:aws:sns:us-east-1:000:order-events'), 'order-events');
  assert.equal(refName({ 'Fn::GetAtt': ['InventoryQueue', 'Arn'] }), 'InventoryQueue');
  assert.equal(joinUrl('http://a:1/', '/b'), 'http://a:1/b');
});
