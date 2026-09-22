import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App, createRuntime, createConfigStore, createLogger, initializeConfig, updateConfig } from '@ireves/common-api';


test('options-object apps snapshot legacy configuration into independent runtimes', async () => {
  initializeConfig({ jwtSecret: 'legacy-initial' });
  const a = await App.create();
  const b = await App.create();
  try {
    assert.notEqual(a.runtime, b.runtime);
    updateConfig({ jwtSecret: 'legacy-rotated' });
    assert.equal(a.runtime.config.jwtSecret(), 'legacy-initial');
    a.runtime.config.update({ jwtSecret: 'app-only' });
    assert.equal(b.runtime.config.jwtSecret(), 'legacy-initial');
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
    a.runtime.logger.flush(); b.runtime.logger.flush();
  }
});

test('JWT configuration is independent from injected database clients', () => {
  const jwt = createConfigStore({ jwtSecret: 'jwt-only' });
  assert.equal(jwt.jwtSecret(), 'jwt-only');
  const runtime = createRuntime({ database: { user: {} } });
  assert.deepEqual(runtime.database, { user: {} });
  assert.throws(runtime.config.jwtSecret, /initializeConfig/);
  const empty = createConfigStore({});
  assert.throws(empty.jwtSecret, /JWT is not configured/);
});

test('independent apps use their own signing keys and request contexts', async () => {
  const runtimeA = createRuntime({ config: { jwtSecret: 'app-a' }, logging: { silent: true } });
  const runtimeB = createRuntime({ config: { jwtSecret: 'app-b' }, logging: { silent: true } });
  const routes = [{ path: '/', models: [{ method: 'get', path: '/', authType: 'access',
    controller: (_req, res) => res.json({ sub: res.locals.auth.sub, requestId: res.locals.requestId }),
  }] }];
  const a = await App.create({ runtime: runtimeA, routers: routes });
  const b = await App.create({ runtime: runtimeB, routers: routes });
  try {
    const servers = await Promise.all([a.listen(0), b.listen(0)]);
    const token = await runtimeA.jwt.createAccessToken({ sub: 'a-user' });
    const request = server => fetch(`http://127.0.0.1:${server.address().port}`, { headers: { Authorization: `Bearer ${token}` } });
    const response = await request(servers[0]);
    const payload = await response.json();
    assert.equal(payload.sub, 'a-user');
    assert.equal(payload.requestId, response.headers.get('x-request-id'));
    assert.equal((await (await request(servers[1])).json()).status, -101);
    runtimeB.config.update({ jwtSecret: 'app-b-rotated' });
    assert.equal(runtimeA.config.jwtSecret(), 'app-a');
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
    runtimeA.logger.flush(); runtimeB.logger.flush();
  }
});

test('injected clients retain identity and JWT rotation does not replace them', async () => {
  const first = { user: { findMany: async () => [{ id: 1 }] } };
  const second = { user: { findMany: async () => [{ id: 2 }] } };
  const a = createRuntime({ config: { jwtSecret: 'first' }, database: first });
  const b = createRuntime({ database: second });
  a.config.update({ jwtSecret: 'rotated' });
  assert.equal(a.database, first);
  assert.equal(b.database, second);
  assert.deepEqual(await a.database.user.findMany(), [{ id: 1 }]);
  assert.deepEqual(await b.database.user.findMany(), [{ id: 2 }]);
});

test('HTTP deadline aborts request signals and closes connections', async () => {
  const started = Promise.withResolvers();
  let requestSignal;
  const runtime = createRuntime({ logging: { silent: true } });
  const app = await App.create({ runtime, routers: [{ path: '/', models: [{
    method: 'get', path: '/', controller: (_req, res) => { requestSignal = res.locals.signal; started.resolve(); },
  }] }] });
  try {
    const server = await app.listen(0);
    const response = fetch(`http://127.0.0.1:${server.address().port}`).catch(error => error);
    await started.promise;
    await assert.rejects(app.close({ timeoutMs: 20 }), /timed out/);
    assert.equal(requestSignal.aborted, true);
    assert.ok(await response instanceof Error);
    await app.close({ timeoutMs: 1000 });
    const restarted = await app.listen(0);
    assert.equal(restarted.listening, true);
  } finally { await app.close(); runtime.logger.flush(); }
});

test('explicit cancellation bounds HTTP shutdown', async () => {
  const started = Promise.withResolvers();
  const app = await App.create({ routers: [{ path: '/', models: [{
    method: 'get', path: '/', controller: () => { started.resolve(); },
  }] }] });
  try {
    const server = await app.listen(0);
    const response = fetch(`http://127.0.0.1:${server.address().port}`).catch(() => {});
    await started.promise;
    const controller = new AbortController();
    const closing = app.close({ signal: controller.signal });
    controller.abort();
    await assert.rejects(closing, /aborted/);
    await response;
  } finally { await app.close(); }
});
