import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, collectEndpointContracts, createEndpointRoutes, loadEndpoints } from '@ireves/common-api';

test('metadata collection is lazy; HTTP handlers preserve context, parameters and middleware', async () => {
  let invoked = 0;
  const endpoints = [{ operationId: 'get', method: 'get', path: '/items/{id}', metadata: { summary: 'An item' },
    middlewares: [(_req, res, next) => { res.locals.flag = true; next(); }],
    handle(req, res, context) { invoked++; res.json({ value: context.value, id: req.params.id, flag: res.locals.flag }); },
  }];
  assert.equal(collectEndpointContracts(endpoints)[0].metadata.summary, 'An item');
  assert.equal(invoked, 0);
  const a = await App.create({ routers: createEndpointRoutes(endpoints, { value: 1 }) });
  const b = await App.create({ routers: createEndpointRoutes(endpoints, { value: 2 }) });
  try {
    for (const [app, value] of [[a, 1], [b, 2]]) {
      const server = await app.listen(0);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/items/42`);
      assert.deepEqual(await response.json(), { value, id: '42', flag: true });
    }
    assert.equal(invoked, 2);
  } finally { await a.shutdown(); await b.shutdown(); }
});

test('invalid declarations fail without executing request handlers', async () => {
  let invoked = 0;
  const make = overrides => ({ operationId: 'run', method: 'get', path: '/items/{id}',
    handle() { invoked++; }, ...overrides });
  const cases = [
    [[make({}), make({ path: '/other' })], /Duplicate operation ID/],
    [[make({}), make({ operationId: 'other', path: '/ITEMS/{other}/' })], /Duplicate endpoint route/],
    [[make({ path: '/{id}/{id}' })], /Duplicate path parameter/],
    [[make({ path: '/:id' })], /Unsupported endpoint path/],
    [[make({ permission: 1, authType: 'optional' })], /Permission requires/],
    [[make({ method: 'wrong' })], /Unsupported HTTP method/],
  ];
  for (const [endpoints, error] of cases) assert.throws(() => createEndpointRoutes(endpoints, {}), error);
  assert.equal(invoked, 0);
});

test('endpoint auth metadata reaches the normal authentication pipeline', async () => {
  let invoked = false;
  const endpoint = { operationId: 'private', method: 'get', path: '/private', authType: 'access',
    handle(_req, res) { invoked = true; res.sendStatus(200); } };
  const app = await App.create({ routers: createEndpointRoutes([endpoint], undefined) });
  try {
    const server = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/private`);
    assert.equal(response.status, 401);
    assert.equal(invoked, false);
  } finally { await app.shutdown(); }
});

test('discovery only imports matching declarations, sorts them and never executes handlers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'common-api-endpoints-'));
  try {
    await assert.rejects(loadEndpoints(directory), /No endpoint declarations/);
    await writeFile(join(directory, 'ignored.mjs'), 'throw Error("must not import");');
    await writeFile(join(directory, 'ignored.endpoint.ts'), 'throw Error("wrong extension");');
    for (const name of ['z', 'a']) await writeFile(join(directory, `${name}.endpoint.mjs`), `
      export default [{ operationId: '${name}', method: 'get', path: '/${name}',
        handle() { throw Error('must not execute'); } }];`);
    const endpoints = await loadEndpoints(pathToFileURL(directory), { extension: '.mjs' });
    assert.deepEqual(collectEndpointContracts(endpoints).map(c => c.operationId), ['a', 'z']);
    await writeFile(join(directory, 'bad.endpoint.mjs'), 'export default {};');
    await assert.rejects(loadEndpoints(directory, { extension: '.mjs' }), /Invalid endpoint module/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
