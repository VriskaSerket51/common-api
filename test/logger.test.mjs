import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { App, createRuntime, createLogger, MySqlException, serializeError } from '@ireves/common-api';

test('structured request logs retain stack, cause and request ID', async () => {
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const log = createLogger({ destination: stream });
  const runtime = createRuntime({ logger: log });
  const cause = new Error('driver failure');
  const app = await App.create({ runtime, routers: [{ path: '/', models: [{
    method: 'get', path: '/', controller: () => { throw new MySqlException(cause); },
  }] }] });
  try {
    const server = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.status, 500);
    await new Promise((resolve, reject) => log.flush(error => error ? reject(error) : resolve()));
    const record = JSON.parse(lines.join('').trim());
    assert.equal(record.requestId, response.headers.get('x-request-id'));
    assert.equal(record.error.name, 'MySqlException');
    assert.equal(record.error.cause.message, 'driver failure');
    assert.match(record.error.stack, /MySqlException/);
    assert.equal(record.method, 'GET');
  } finally { await app.close(); log.flush(); }
});

test('circular error causes are serializable', () => {
  const error = new Error('circular'); error.cause = error;
  assert.equal(serializeError(error).cause, '[Circular error]');
});

test('shared errors retain details while actual ancestor cycles are marked', () => {
  const shared = new Error('shared');
  const root = new AggregateError([shared, shared], 'root', { cause: shared });
  shared.cause = root;
  const record = serializeError(root);
  for (const item of [record.cause, ...record.errors]) {
    assert.equal(item.message, 'shared');
    assert.equal(item.cause, '[Circular error]');
  }
});

test('Pino preserves direct and aggregate errors, child context and metadata', () => {
  const lines = [];
  const log = createLogger({ destination: { write(line) { lines.push(JSON.parse(line)); } } });
  const cause = new Error('root cause');
  const failure = new AggregateError([cause], 'batch failed', { cause });
  log.child({ requestId: 'request-1' }).error(failure);
  log.info({ userId: 42 }, 'Signed in');
  assert.equal(lines[0].requestId, 'request-1');
  assert.equal(lines[0].err.name, 'AggregateError');
  assert.equal(lines[0].err.cause.message, 'root cause');
  assert.equal(lines[0].err.errors[0].message, 'root cause');
  assert.match(lines[0].err.stack, /batch failed/);
  assert.equal(lines[1].userId, 42);
  assert.equal(lines[1].msg, 'Signed in');
});

test('level filtering and silent mode preserve caller-owned streams', async () => {
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const log = createLogger({ level: 'warn', destination: stream });
  log.info('filtered');
  log.warn('visible');
  createLogger({ silent: true, destination: stream }).fatal('hidden');
  await new Promise((resolve, reject) => log.flush(error => error ? reject(error) : resolve()));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).msg, 'visible');
  assert.equal(stream.writableEnded, false);
  stream.end();
});
