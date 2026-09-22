import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App, createRuntime } from '@ireves/common-api';

test('injected clients work in controllers and disconnect only after HTTP work drains', async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  const database = {
    user: { async findMany() { started.resolve(); await finish.promise; events.push('query'); return [{ id: 1 }]; } },
    async $disconnect() { events.push('disconnect'); },
  };
  const runtime = createRuntime({ database, disconnectDatabase: client => client.$disconnect() });
  const app = await App.create({ runtime, routers: [{ path: '/', models: [{
    method: 'get', path: '/', controller: async (_req, res) => res.json(await runtime.database.user.findMany()),
  }] }] });
  try {
    const server = await app.listen(0);
    const response = fetch(`http://127.0.0.1:${server.address().port}/`);
    await started.promise;
    const shutdown = app.shutdown();
    await Promise.resolve();
    assert.deepEqual(events, []);
    finish.resolve();
    assert.deepEqual(await (await response).json(), [{ id: 1 }]);
    await shutdown;
    assert.deepEqual(events, ['query', 'disconnect']);
    assert.equal(app.runtime.database, database);
    await app.shutdown();
    assert.deepEqual(events, ['query', 'disconnect']);
  } finally { finish.resolve(); await app.shutdown(); }
});

test('shared clients remain caller-owned without an explicit disconnect callback', async () => {
  let closed = 0;
  const database = { async $disconnect() { closed++; } };
  const a = await App.create({ runtime: createRuntime({ database }) });
  const b = await App.create({ runtime: createRuntime({ database }) });
  await Promise.all([a.shutdown(), b.shutdown()]);
  assert.equal(closed, 0);
  await database.$disconnect();
  assert.equal(closed, 1);
  const empty = await App.create();
  assert.equal(empty.runtime.database, undefined);
  await empty.shutdown();
});

test('concurrent disconnects share work and a timeout does not restart it', async () => {
  let calls = 0;
  const gate = Promise.withResolvers();
  const runtime = createRuntime({ database: {}, disconnectDatabase: () => { calls++; return gate.promise; } });
  const short = runtime.closeDatabase({ timeoutMs: 10 });
  const waiting = runtime.closeDatabase({ timeoutMs: 1000 });
  try {
    await assert.rejects(short, /timed out/);
    assert.equal(calls, 1);
    gate.resolve();
    await waiting;
    await runtime.closeDatabase();
    assert.equal(calls, 1);
  } finally { gate.resolve(); await waiting; }
});

test('failed disconnects preserve their error and can be retried', async () => {
  let calls = 0;
  const failure = new Error('disconnect failed');
  const runtime = createRuntime({ database: {}, disconnectDatabase: () => {
    if (++calls === 1) throw failure;
  } });
  await assert.rejects(runtime.closeDatabase(), error => error === failure);
  await runtime.closeDatabase();
  await runtime.closeDatabase();
  assert.equal(calls, 2);
});

test('abort stops waiting without interrupting a pending disconnect', async () => {
  let calls = 0;
  const gate = Promise.withResolvers();
  const runtime = createRuntime({ database: {}, disconnectDatabase: () => { calls++; return gate.promise; } });
  const controller = new AbortController();
  const closing = runtime.closeDatabase({ signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(closing, /aborted/);
  gate.resolve();
  await runtime.closeDatabase();
  assert.equal(calls, 1);
});

test('invalid or already-aborted close requests do not start disconnecting', async () => {
  let calls = 0;
  const runtime = createRuntime({ database: {}, disconnectDatabase: () => { calls++; } });
  assert.throws(() => runtime.closeDatabase({ timeoutMs: -1 }), /timeoutMs/);
  await assert.rejects(runtime.closeDatabase({ signal: AbortSignal.abort() }), /aborted/);
  assert.equal(calls, 0);
  await runtime.closeDatabase();
  assert.equal(calls, 1);
  assert.throws(() => createRuntime({ disconnectDatabase() {} }), /requires a database/);
});

test('client methods, transaction context and errors pass through unchanged', async () => {
  const failure = new Error('query failed');
  const transaction = { user: { async create() { throw failure; } } };
  const database = { $transaction(work) { assert.equal(this, database); return work(transaction); } };
  const runtime = createRuntime({ database });
  await assert.rejects(runtime.database.$transaction(tx => tx.user.create()), error => error === failure);
  assert.equal(runtime.database, database);
});
