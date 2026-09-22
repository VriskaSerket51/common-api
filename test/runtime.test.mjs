import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import mysql from 'mysql2/promise';
import { App, createRuntime, createConfigStore, createLogger, initializeConfig, updateConfig } from '@ireves/common-api';

const dbConfig = { host: 'localhost', port: 3306, user: 'test', password: '', database: 'test' };

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
    a.runtime.logger.close(); b.runtime.logger.close();
  }
});

test('JWT-only and database-only stores validate only enabled features', () => {
  const jwt = createConfigStore({ jwtSecret: 'jwt-only' });
  assert.equal(jwt.jwtSecret(), 'jwt-only');
  assert.throws(jwt.database, /Database is not configured/);
  const db = createConfigStore({ db: dbConfig });
  assert.equal(db.database().database, 'test');
  assert.throws(db.jwtSecret, /JWT is not configured/);
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
    runtimeA.logger.close(); runtimeB.logger.close();
  }
});

test('same database values and JWT-only updates keep the pool; separate runtimes get separate pools', async () => {
  const factories = [];
  const factory = mock.method(mysql, 'createPool', options => {
    const fake = { async execute() { return [[{ database: options.database }], []]; }, async end() {} };
    factories.push(fake);
    return fake;
  });
  const log = createLogger({ silent: true });
  const a = createRuntime({ config: { jwtSecret: 'first', db: dbConfig }, logger: log });
  const b = createRuntime({ config: { db: { ...dbConfig, database: 'other' } }, logger: log });
  try {
    assert.equal((await a.database.getFirstAsync('select')).database, 'test');
    a.config.initialize({ db: { ...dbConfig, connectionLimit: 10 }, jwtSecret: 'second' });
    await a.database.getAllAsync('select');
    a.config.update({ jwtSecret: 'third' });
    await a.database.getAllAsync('select');
    assert.equal(factories.length, 1);
    assert.equal((await b.database.getFirstAsync('select')).database, 'other');
    assert.equal(factories.length, 2);
    a.config.update({ db: { ...dbConfig, database: 'changed' } });
    await assert.rejects(a.database.getAllAsync('select'), /closeDatabase/);
    assert.equal((await b.database.getFirstAsync('select')).database, 'other');
  } finally {
    await Promise.all([a.database.closeDatabase(), b.database.closeDatabase()]);
    factory.mock.restore(); log.close();
  }
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
  } finally { await app.close(); runtime.logger.close(); }
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
