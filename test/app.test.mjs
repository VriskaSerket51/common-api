import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  App, HttpException, ResponseException, createAccessToken,
  initializeConfig, defaultErrorHandler, logger,
} from '@ireves/common-api';

initializeConfig({ jwtSecret: 'app-test-secret', db: {
  host: 'localhost', port: 3306, user: 'test', password: '', database: 'test',
} });
after(() => logger.close());

test('options register routes, enforce auth before local middleware, and prioritize custom errors', async () => {
  const calls = [];
  const app = await App.create({
    cors: { origin: 'https://example.com' },
    middlewares: [(_req, _res, next) => { calls.push('global'); next(); }],
    routers: [{ path: '/api', models: [
      { method: 'get', path: '/private', authType: 'access',
        middlewares: [(_req, _res, next) => { calls.push('route'); next(); }],
        controller: (_req, res) => { calls.push('controller'); res.json({ ok: true }); } },
      { method: 'get', path: '/failure', controller: async () => { throw new Error('custom'); } },
      { method: 'get', path: '/http', controller: () => { throw new HttpException(409); } },
      { method: 'get', path: '/response', controller: () => { throw new ResponseException(-2, 'expected'); } },
      { method: 'post', path: '/json', controller: (req, res) => res.json(req.body) },
    ] }],
    errorHandlers: [(error, _req, res, next) => {
      if (error.message === 'custom') res.status(422).json({ handled: true });
      else next(error);
    }],
  });
  try {
    const server = await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    assert.equal((await fetch(`${base}/private`)).status, 401);
    assert.deepEqual(calls.splice(0), ['global']);
    const response = await fetch(`${base}/private`, {
      headers: { Authorization: `Bearer ${await createAccessToken({ sub: 'user' })}` },
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.com');
    assert.deepEqual(calls.splice(0), ['global', 'route', 'controller']);
    const failure = await fetch(`${base}/failure`);
    assert.equal(failure.status, 422);
    assert.deepEqual(await failure.json(), { handled: true });
    assert.equal((await fetch(`${base}/http`)).status, 409);
    const businessError = await fetch(`${base}/response`);
    assert.equal(businessError.status, 200);
    assert.deepEqual(await businessError.json(), { status: -2, message: 'expected' });
    assert.equal((await fetch(`${base}/json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
    })).status, 400);
  } finally {
    await app.close();
  }
});

test('close waits for active requests, allows repeated calls, and supports restart', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const app = await App.create({ cors: false, routers: [{ path: '/', models: [
    { method: 'get', path: '/', controller: async (_req, res) => {
      started.resolve();
      await release.promise;
      res.send('finished');
    } },
  ] }] });
  const server = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    await assert.rejects(app.listen(0), /already/);
    const response = fetch(`http://127.0.0.1:${server.address().port}/`);
    await started.promise;
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    const secondClose = app.close();
    await setImmediate();
    assert.equal(closed, false);
    release.resolve();
    const result = await response;
    assert.equal(await result.text(), 'finished');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
    await Promise.all([closing, secondClose]);
    assert.equal(server.listening, false);
    await app.close();
    assert.equal((await app.listen(0)).listening, true);
  } finally {
    release.resolve();
    await app.close();
  }
});

test('failed listen can be retried and immediate close waits for startup', async () => {
  const occupied = await App.create();
  const app = await App.create();
  try {
    const server = await occupied.listen(0);
    await assert.rejects(app.listen(server.address().port), { code: 'EADDRINUSE' });
    const starting = app.listen(0);
    const closing = app.close();
    const restarted = await starting;
    await closing;
    assert.equal(restarted.listening, false);
  } finally {
    await Promise.all([app.close(), occupied.close()]);
  }
});

test('default error handler delegates errors after response headers are sent', () => {
  const error = new Error('stream failed');
  let delegated;
  defaultErrorHandler(error, {}, { headersSent: true }, value => { delegated = value; });
  assert.equal(delegated, error);
});
