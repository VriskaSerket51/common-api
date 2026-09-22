import assert from 'node:assert/strict';
import { test } from 'node:test';
import legacy, * as root from '@ireves/common-api';
import { App } from '@ireves/common-api/app';
import { createRuntime } from '@ireves/common-api/runtime';
import { HttpException } from '@ireves/common-api/errors';
import { createJwt } from '@ireves/common-api/jwt';
import * as middleware from '@ireves/common-api/middleware';

test('root, feature and legacy imports share the same objects', async () => {
  assert.equal(App, root.App);
  assert.equal(createRuntime, root.createRuntime);
  assert.equal(HttpException, root.HttpException);
  assert.equal(createJwt, root.createJwt);
  assert.equal(legacy.HttpException, HttpException);
  assert.equal(legacy.defaultRuntime, root.defaultRuntime);
  class CustomError extends HttpException {}
  assert.ok(new CustomError(409) instanceof root.HttpException);
  const runtime = createRuntime({ database: { user: {} } });
  const app = await App.create({ runtime });
  assert.equal(app.runtime, runtime);
  await app.shutdown();
});

test('middleware exports do not implicitly forward JWT or internal shutdown helpers', () => {
  assert.equal(middleware.createRouterMiddlewares, root.createRouterMiddlewares);
  assert.equal('createJwt' in middleware, false);
  assert.equal('waitForShutdown' in root, false);
  assert.equal('validateShutdownOptions' in root, false);
});

test('undocumented internal and removed DB paths cannot be imported', async () => {
  for (const path of ['dist/index.js', 'dist/shutdown.js', 'public-api', 'export', 'mysql']) {
    await assert.rejects(import(`@ireves/common-api/${path}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
