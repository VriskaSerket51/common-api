import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, createRuntime } from '@ireves/common-api';

test('one routes factory uses each app database, JWT and logger without global imports', async () => {
  const seen = [];
  const factory = async runtime => {
    seen.push(runtime);
    return [{ path: '/', models: [{ method: 'get', path: '/',
      controller: async (_req, res) => {
        runtime.logger.info('query');
        res.json({ rows: await runtime.database.user.findMany(),
          token: await runtime.jwt.createAccessToken({ sub: runtime.database.name }) });
      },
    }] }];
  };
  const apps = [];
  try {
    for (const name of ['first', 'second']) {
      const database = { name, user: { findMany: async () => [name] } };
      const runtime = createRuntime({ database, config: { jwtSecret: name }, logging: { silent: true } });
      const app = await App.create({ runtime, routers: factory });
      apps.push(app);
      const services = seen.at(-1);
      for (const key of ['database', 'jwt', 'logger', 'scheduler', 'config']) {
        assert.equal(services[key], runtime[key]);
      }
      assert.equal('closeDatabase' in services, false);
      assert.equal(Object.isFrozen(services), true);
      const server = await app.listen(0);
      const result = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
      assert.deepEqual(result.rows, [name]);
      assert.equal((await runtime.jwt.verifyJwt(result.token)).sub, name);
      if (apps.length === 2) await assert.rejects(apps[0].runtime.jwt.verifyJwt(result.token));
    }
  } finally {
    await Promise.all(apps.map(app => app.shutdown()));
  }
});

test('discovered routes factories receive each app runtime and skip unrelated functions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'common-api-injection-'));
  const entry = new URL('../../dist/index.js', import.meta.url).href;
  const apps = [];
  try {
    await writeFile(path.join(directory, 'routes.mjs'), `
      import { defineRoutes } from ${JSON.stringify(entry)};
      export default defineRoutes(async (services) => {
        if ('closeDatabase' in services) throw new Error('Lifecycle leaked');
        const { database } = services;
        return [{ path: '/', models: [{
        method: 'get', path: '/', controller: async (_req, res) => res.json(await database.read()),
      }] }]; });
    `);
    await writeFile(path.join(directory, 'helper.mjs'), 'export default () => { throw new Error("not a router"); };');
    for (const value of ['a', 'b']) {
      const app = await App.create({ runtime: createRuntime({ database: { read: async () => value } }), routerDir: directory });
      apps.push(app);
      const server = await app.listen(0);
      assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json(), value);
    }
    await writeFile(path.join(directory, 'failure.mjs'), `
      import { defineRoutes } from ${JSON.stringify(entry)};
      export default defineRoutes(async () => { throw new Error('factory failed'); });
    `);
    await assert.rejects(App.create({ routerDir: directory }), /factory failed/);
  } finally {
    await Promise.all(apps.map(app => app.shutdown()));
    await rm(directory, { recursive: true, force: true });
  }
});
