# common-api

An ESM TypeScript backend library with Express 5, JWT, MySQL pools and scheduled
jobs. Requires **Node.js 22.13.0+**. See [MIGRATION.md](./MIGRATION.md) when upgrading
from 1.x.

```sh
npm install @ireves/common-api
```

Set `"type": "module"` in your application.

## Create an app

```typescript
import { App, type RouterDefinition } from '@ireves/common-api';

const health = {
  path: '/health',
  models: [{
    method: 'get', path: '/',
    controller: (_req, res) => res.json({ status: 'ok' }),
  }],
} satisfies RouterDefinition;

const app = await App.create({
  routers: [health],
  cors: { origin: 'https://example.com' },
});
await app.listen({ port: 3000, host: '127.0.0.1' });
// On shutdown: await app.shutdown({ timeoutMs: 10_000 });
```

Options-object apps own independent runtimes. An initialized global configuration
is copied at creation; subsequent global changes do not affect the app. Positional
`App.create(...)` and module-level helpers use the shared legacy runtime.
Pass `runtime` explicitly when resource sharing is intentional.

## Routes

Use plain `RouterDefinition` objects or `RouterBase` subclasses. Models define
`method`, `path`, `controller`, optional `authType`, `permission`, and `middlewares`.
Default authentication/permission middleware runs before route-specific middleware.

To discover default-exported `RouterBase` subclasses from files:

```typescript
import { App } from '@ireves/common-api';
import { fileURLToPath } from 'node:url';

const app = await App.create({
  routerDir: fileURLToPath(new URL('./router/', import.meta.url)),
});
```

Discovery supports `.js`, `.mjs`, `.ts`, `.mts`, excluding declaration files. Use
`tsx` for TypeScript development and compiled JavaScript in production. Relative
TypeScript imports use output extensions (`./router.js`). Explicit `routers` run
before discovered ones when both options are present.

## JWT and permissions

JWT-only apps do not need database configuration:

```typescript
import { App } from '@ireves/common-api';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error('JWT_SECRET is required');

const app = await App.create({
  config: { jwtSecret },
  permissionChecker: (permission, _req, res) => {
    const grants: unknown = res.locals.auth?.permissions;
    return Array.isArray(grants) && grants.includes(permission);
  },
  routers: [{ path: '/admin', models: [{
    method: 'get', path: '/', permission: 7,
    controller: (_req, res) => res.json({ user: res.locals.auth?.sub }),
  }] }],
});

const token = await app.runtime.jwt.createAccessToken({ sub: 'user-1', permissions: [7] });
```

Access tokens default to 10 minutes, refresh tokens to 6 hours. No fallback key
is provided. Verified claims are in `res.locals.auth`. Optional auth allows missing
credentials, but rejects invalid ones. Signing options are copied, not mutated.

JWT uses `jose`. Token creation and verification return promises:

```typescript
const token = await app.runtime.jwt.createAccessToken({ sub: 'user-1' }, {
  issuer: 'my-issuer', audience: 'my-api',
});
const claims = await app.runtime.jwt.verifyJwt(token, { issuer: 'my-issuer', audience: 'my-api' });
```

For issuer/audience validation, include those claims when issuing the token via
the signing options. This service signs and verifies **HS256 only**; public-key
configuration is not included yet. Use a cryptographically random secret of at
least 32 bytes. Existing HS256 tokens retain compatibility with the same UTF-8 key.
Signing options support `expiresIn`, `notBefore`, `issuer`, `audience`, `subject`,
`jwtid`, `noTimestamp`, and `algorithm: 'HS256'`. Durations are seconds or explicit
`s`/`m`/`h`/`d`/`w` strings (for example `600`, `'10m'`); unitless strings are rejected.
`verifyJwt` takes verification options instead of a callback and returns claims.
Route middleware currently enforces signature, timestamps and token type; optional
issuer/audience restrictions are supplied to `verifyJwt` by custom middleware.

Permission routes require an explicit checker and an access token. The checker
can be async; false returns 403. Numeric permissions have no implicit ordering or
bitmask meaning. Without a checker, permission routes fail at initialization.

`runtime.config.update({ jwtSecret: newKey })` rotates only that runtime's key.
`initialize()` replaces all configuration. Use `createRuntime({ config, logger })`
for explicit resource injection, then `App.create({ runtime })`.

## MySQL

DB-only applications do not need JWT settings:

```typescript
import { createRuntime } from '@ireves/common-api';

const runtime = createRuntime({ config: { db: {
  host: '127.0.0.1', port: 3306, user: 'app', database: 'app',
  password: process.env.DB_PASSWORD ?? '', connectionLimit: 10,
} } });

const rows = await runtime.database.getAllAsync('SELECT id FROM users WHERE active = ?', [true]);
await runtime.database.withTransaction(async connection => {
  await connection.execute('UPDATE accounts SET balance = balance - ? WHERE id = ?', [10, 1]);
  await connection.execute('UPDATE accounts SET balance = balance + ? WHERE id = ?', [10, 2]);
});
await runtime.database.closeDatabase({ timeoutMs: 5000 });
```

Pools are lazy. Reapplying equal DB values or rotating a JWT key preserves the
pool. Changed DB connection values require finishing work and closing the old
pool first. Transactions commit on success, roll back on failure, and discard
connections if rollback fails. Always use the supplied transaction connection.
Dedicated `connection()` callers are responsible for calling `end()`.

## Scheduling and shutdown

```typescript
import { setTimeout } from 'node:timers/promises';

app.runtime.scheduler.initialize([{
  name: 'refresh-cache', cron: '*/30 * * * * *', overlap: 'skip',
  job: async ({ signal, scheduledAt }) => {
    await setTimeout(100, undefined, { signal });
    app.runtime.logger.info('Cache refreshed', { scheduledAt });
  },
}]);

await app.shutdown({ timeoutMs: 10_000 });
```

`overlap: 'skip'` is the default; `'allow'` permits concurrent invocations. Job names
are unique per scheduler, so separate runtimes can use the same names. Jobs receive
a cancellation signal and a copy of their scheduled date.

`close()` drains HTTP only. `shutdown()` stops HTTP and jobs before closing the
runtime's pool, sharing a total default deadline of 30 seconds. Both accept
`{ timeoutMs, signal }`. Timeout/cancellation closes HTTP connections and aborts
request signals. Jobs must cooperate with cancellation; arbitrary JavaScript
cannot be forcibly stopped. If jobs do not finish, shutdown rejects, the database
stays open, and the scheduler rejects new work until they settle.

`res.locals.signal` also aborts on client disconnection. The library does not
install global process signal handlers; connect your own handler to `shutdown()`.

## Errors and logging

Custom four-argument `errorHandlers` run before the fallback; call `next(error)`
to delegate. Parser errors preserve HTTP 4xx, unexpected failures return 500.
Legacy `ResponseException` retains HTTP 200 with an application status code.

The default logger writes JSON to stdout. Error logs preserve stacks, causes and
aggregate errors, along with request ID, method and path. `res.locals.log` carries
the ID returned through `X-Request-Id`. No log directory is created on import.
Use `createLogger({ logDir: 'logs' })` for optional daily files or inject a logger
through `createRuntime({ logger })`. Logger lifecycle belongs to the application.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run test:package
```

Development uses `tsx`; builds use TypeScript 7 with `NodeNext`. `npm pack` runs
type checking and tests on a fresh build. Only `dist/` and package documentation
are shipped. Package checks extract the tarball and compile/run a typed ESM consumer.

CI covers Node 22.13.0, 24 and 26 on Linux and Windows. **Real MySQL tests are
optional and disabled for push/PR CI.** Enable the `mysql` input manually in CI,
or set `MYSQL_TEST_HOST`, `MYSQL_TEST_PORT`, `MYSQL_TEST_USER`,
`MYSQL_TEST_PASSWORD`, `MYSQL_TEST_DATABASE` and run `npm run test:integration`.
The database name must start with `common_api_test`; tests create/remove a unique
table and terminate only a connection they created. No live DB test was run during
this update.
