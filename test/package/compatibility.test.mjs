import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import api, { App, createRouterByFiles } from '@ireves/common-api';

api.initializeConfig({
  jwtSecret: 'migration-test-secret',
});
after(() => api.logger.flush());

test('package exports provide the default API and named ESM exports', () => {
  assert.equal(api.App, App);
  assert.equal(api.createRouterByFiles, createRouterByFiles);
});

test('App.create rejects when a router module cannot be initialized', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'common-api-failure-'));
  try {
    writeFileSync(path.join(directory, 'broken.mjs'),
      'await Promise.reject(new Error("router initialization failed"));');
    await assert.rejects(
      api.App.create(directory, [], api.defaultRouterMiddlewares, []),
      /router initialization failed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tsx loads TypeScript file routers during development', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'common-api-ts-'));
  const entry = new URL('../../src/index.ts', import.meta.url).href;
  try {
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(directory, 'development.ts'), `
      import { RouterBase, type ModelBase } from ${JSON.stringify(entry)};
      export default class extends RouterBase {
        path = '/development';
        models: ModelBase[] = [{ method: 'get', path: '/',
          controller: (req, res) => res.json({ development: true }) }];
      }
    `);
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      import api from ${JSON.stringify(entry)};
      const app = await api.App.create(${JSON.stringify(directory)}, [], api.defaultRouterMiddlewares, []);
      const server = app.expressApp.listen(0, '127.0.0.1');
      try {
        await once(server, 'listening');
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/development');
        assert.deepEqual(await response.json(), { development: true });
      } finally {
        await new Promise(resolve => server.close(resolve));
        api.logger.flush();
      }
    `], { timeout: 10000, stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file routers, JWTs and rejected async controllers work with Express 5', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'common-api test #-'));
  const entry = new URL('../../dist/index.js', import.meta.url).href;
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(directory, 'users.js'), `
    import { RouterBase, HttpException } from ${JSON.stringify(entry)};
    await Promise.resolve();
    export default class extends RouterBase {
      path = '/users';
      models = [
        { method: 'get', path: '/me', authType: 'access',
          controller: (req, res) => res.json({ ok: true }) },
        { method: 'post', path: '/refresh', authType: 'refresh',
          controller: (req, res) => res.sendStatus(204) },
        { method: 'get', path: '/error', controller: async () => {
          await Promise.resolve();
          throw new HttpException(418);
        } },
        { method: 'get', path: '/:id',
          controller: (req, res) => res.json({ id: req.params.id }) },
      ];
    };
  `);
  writeFileSync(path.join(directory, 'users.d.ts'), 'declare const unused: string;');
  writeFileSync(path.join(directory, 'users.d.mts'), 'declare const unused: string;');
  writeFileSync(path.join(directory, 'helper.mjs'), 'export default {};');
  let server;
  try {
    const app = await api.App.create(directory, [], api.defaultRouterMiddlewares, []);
    server = app.expressApp.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const access = await api.createAccessToken({ sub: 'test-user' });
    const refresh = await api.createRefreshToken({ sub: 'test-user' });
    const decoded = await api.verifyJwt(access);
    assert.match(decoded.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal((await fetch(`${base}/users/me`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/users/me`, {
      headers: { Authorization: `Bearer ${access}` },
    })).json(), { ok: true });
    assert.equal((await (await fetch(`${base}/users/me`, {
      headers: { Authorization: `Bearer ${refresh}` },
    })).json()).status, -101);
    assert.equal((await fetch(`${base}/users/refresh`, {
      method: 'POST', headers: { Authorization: `Bearer ${refresh}` },
    })).status, 204);
    assert.equal((await fetch(`${base}/users/error`)).status, 418);
    assert.deepEqual(await (await fetch(`${base}/users/123`)).json(), { id: '123' });
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('App.run reports occupied ports only through onFailed', { timeout: 5000 }, async () => {
  const occupied = http.createServer();
  occupied.listen(0);
  await once(occupied, 'listening');
  try {
    const app = await api.App.create('', [], api.defaultRouterMiddlewares, []);
    let successCount = 0;
    let failureCount = 0;
    const error = await new Promise(resolve => app.run(
      occupied.address().port,
      () => { successCount++; },
      error => { failureCount++; resolve(error); },
    ));
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(successCount, 0);
    assert.equal(failureCount, 1);
  } finally {
    await new Promise(resolve => occupied.close(resolve));
  }
});

test('App.run calls onSuccessed when the server is listening', { timeout: 5000 }, async () => {
  const app = await api.App.create('', [], api.defaultRouterMiddlewares, []);
  const listen = app.expressApp.listen.bind(app.expressApp);
  let server;
  app.expressApp.listen = (...args) => { server = listen(...args); return server; };
  try {
    await new Promise((resolve, reject) => app.run(0, resolve, reject));
    assert.equal(server.listening, true);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
