import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  App, getConfig, initializeConfig, createAccessToken, createRefreshToken,
  verifyJwt, createRouterMiddlewares, logger,
} from '@ireves/common-api';

const config = { jwtSecret: 'explicit-test-secret', db: {
  host: 'localhost', port: 3306, user: 'test', password: '', database: 'test',
} };
after(() => logger.close());

test('configuration is required, validated and copied before JWT use', () => {
  assert.throws(() => createAccessToken({}), /initializeConfig/);
  for (const jwtSecret of ['', ' ', 'jwtSecret']) {
    assert.throws(() => initializeConfig({ ...config, jwtSecret }), /jwtSecret/);
  }
  assert.throws(() => initializeConfig({ ...config, db: { ...config.db, port: 0 } }), /database/);
  initializeConfig(config);
  config.db.host = 'changed';
  assert.equal(getConfig().db.host, 'localhost');
  assert.equal(Object.isFrozen(getConfig().db), true);
  assert.throws(() => initializeConfig({ ...config, jwtSecret: '' }), /jwtSecret/);
  assert.equal(getConfig().jwtSecret, 'explicit-test-secret');
});

test('token creation preserves caller options and explicit zero expiry', async () => {
  const options = Object.freeze({ expiresIn: 0 });
  const token = createAccessToken({ sub: 'expired' }, options);
  const error = await new Promise(resolve => verifyJwt(token, err => resolve(err)));
  assert.equal(error.name, 'TokenExpiredError');
  assert.deepEqual(options, { expiresIn: 0 });
});

test('permission routes fail at startup without a checker', async () => {
  await assert.rejects(App.create({ routers: [{ path: '/', models: [{
    method: 'get', path: '/', permission: 7, controller: (_req, res) => res.sendStatus(200),
  }] }] }), /PermissionChecker/);
});

test('verified identity, permissions and invalid optional credentials are enforced', async () => {
  let checks = 0;
  const controller = (_req, res) => res.json({ sub: res.locals.auth?.sub ?? null });
  const app = await App.create({
    routerMiddleware: createRouterMiddlewares(async (permission, _req, res) => {
      checks++;
      return res.locals.auth.permissions?.includes(permission) === true;
    }),
    routers: [{ path: '/', models: [
      { method: 'get', path: '/protected', permission: 7, controller },
      { method: 'get', path: '/optional', authType: 'optional', controller },
    ] }],
  });
  try {
    const server = await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, token) => fetch(base + route, token ? { headers: { Authorization: token } } : {});
    assert.equal((await request('/protected')).status, 401);
    assert.equal(checks, 0);
    assert.equal((await request('/protected', `Bearer ${createAccessToken({ sub: 'denied' })}`)).status, 403);
    const authorized = await request('/protected', `bearer ${createAccessToken({ sub: 'allowed', permissions: [7] })}`);
    assert.deepEqual(await authorized.json(), { sub: 'allowed' });
    assert.deepEqual(await (await request('/optional')).json(), { sub: null });
    assert.equal((await request('/optional', 'Basic invalid')).status, 401);
    for (const [token, expected] of [
      ['invalid', -101], [createRefreshToken({}), -101], [createAccessToken({}, { expiresIn: 0 }), -100],
    ]) {
      const result = await (await request('/optional', `Bearer ${token}`)).json();
      assert.equal(result.status, expected);
    }
  } finally { await app.close(); }
});
