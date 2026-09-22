# common-api

An ESM TypeScript backend library with Express 5, JWT, typed database injection and scheduled
jobs. Requires **Node.js 22.13.0+**. See [MIGRATION.md](./MIGRATION.md) when upgrading
from 1.x.

```sh
npm install @ireves/common-api
```

Set `"type": "module"` in your application.

## Imports

Prefer named imports from the root or a documented feature path:

```typescript
import { App, createRuntime } from '@ireves/common-api';
import { HttpException, type HttpExceptionOptions } from '@ireves/common-api/errors';
import { createJwt } from '@ireves/common-api/jwt';
```

| Path suffix | Public API |
| --- | --- |
| `/app` | App, AppOptions, ShutdownOptions |
| `/runtime` | Runtime creation, types and compatibility runtime |
| `/config` | Configuration store and JWT configuration helpers |
| `/errors` | Exception classes and HttpExceptionOptions |
| `/logger` | Logger factory, error serialization and types |
| `/jwt` | Token creation, verification and auth middleware |
| `/middleware` | Router middleware composition and error handlers |
| `/router` | Router factories and route definitions |
| `/scheduler` | Scheduler factory, job handles and lifecycle types |
| `/utils` | File discovery helpers |

The root explicitly lists its public symbols; implementation-only exports are not
forwarded automatically. Root and feature paths reference the same implementations
and compatibility instances. Feature paths avoid loading unrelated root exports,
though their own dependencies still load. Do not import `dist/*` or source paths.
The legacy default namespace import remains supported but is deprecated. Types
should use `import type`; new code should use named imports.

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

## Database injection (Prisma or another client)

The application owns the database schema, migrations, driver adapter and client
creation. This package does not install Prisma or a database driver and does not
connect on import. Configure your Prisma client in your application's
`database.ts` following the [Prisma documentation](https://www.prisma.io/docs/orm).
The example below assumes that client has a `User` model.

`runtime.database` is the exact object supplied, retaining all model and transaction
types. DB-only apps need no JWT settings:

```typescript
import { App, createRuntime } from '@ireves/common-api';
import { prisma } from './database.js'; // Your app's configured Prisma client.

const runtime = createRuntime({
  database: prisma,
  disconnectDatabase: client => client.$disconnect(),
});
const app = await App.create({
  runtime,
  routers: ({ database }) => [{ path: '/users', models: [{
    method: 'get', path: '/',
    controller: async (_req, res) => {
      const users = await database.user.findMany({ select: { id: true } });
      res.json(users);
    },
  }] }],
});
await app.listen(3000);
// On shutdown, after HTTP and jobs finish:
await app.shutdown({ timeoutMs: 5000 });
```

Use your client's transaction API directly (for Prisma, `$transaction`); the
framework neither wraps query errors nor changes transaction behavior. There is
no global DB client. Without injection, `runtime.database` is `undefined`.
`AppOptions<typeof prisma>` and `RuntimeOptions<typeof prisma>` preserve client
types when storing options in variables.

### Dependency injection into routes

`routers` accepts an array or an async factory receiving the app's `RouteServices`. The
factory runs once per `App.create`, so the same routes can use a production client
or a test double without importing a global database or app. Its database type is
inferred from `runtime`. Controllers close over those dependencies; no request cast
or global Express type augmentation is needed.

Services contain `database`, `jwt`, `logger`, `scheduler` and `config`, preserving
their original identities. The shallow-frozen services object excludes
`closeDatabase`; app startup and shutdown remain the entry point's responsibility.
This is an API boundary, not a security sandbox: service APIs such as the database
client's own `$disconnect()` are unchanged.

Prefer explicit imports and factory composition, so TypeScript checks that each
route receives the dependencies it needs. A route can declare only its required
subset, allowing unit tests to supply only that subset:

```typescript
// routes/users.ts
import type { RouteServices, RouterDefinition } from '@ireves/common-api';
import type { prisma } from '../database.js';

export const userRoutes = (
  { database }: Pick<RouteServices<typeof prisma>, 'database'>,
): readonly RouterDefinition[] => [{
  path: '/users',
  models: [{ method: 'get', path: '/', controller: async (_req, res) => {
    res.json(await database.user.findMany());
  } }],
}];
```

```typescript
// Application entry point, with runtime already configured:
import { userRoutes } from './routes/users.js';
import { authRoutes } from './routes/auth.js';

const app = await App.create({
  runtime,
  routers: async services => [
    ...userRoutes(services),
    ...await authRoutes(services),
  ],
});
```

For optional file discovery, default-export a factory marked with `defineRoutes`:

```typescript
import { defineRoutes, type RouteServices } from '@ireves/common-api';
import type { prisma } from '../database.js';

export default defineRoutes(({ database }: RouteServices<typeof prisma>) => [{
  path: '/users',
  models: [{
    method: 'get', path: '/', authType: 'access',
    controller: async (_req, res) => {
      const users = await database.user.findMany();
      res.locals.log?.info({ count: users.length }, 'Listed users');
      res.json(users);
    },
  }],
}]);
```

`App.create({ runtime, routerDir })` supplies its services to every marked factory.
File discovery happens at runtime, so the application must ensure the database
type declared by each file matches the supplied client. Ordinary default-exported
functions are ignored; existing `RouterBase` classes retain their behavior.

The injected `jwt` signs tokens with the same service used by route authentication.
`logger` is the app logger (use `res.locals.log` for request IDs), and `scheduler`
is the instance drained by `app.shutdown()` before database disconnection. `config`
is the app's configuration store. These dependencies therefore share the app's
configuration and lifetime. Factories should define routes; start background work
after `App.create` succeeds to avoid leaving work running after a startup failure.

Omit `disconnectDatabase` for shared/external ownership: `shutdown()` will not
close the client, even if it has `$disconnect()`. The application must disconnect
shared clients after **all** users have stopped. If multiple apps share a runtime,
coordinate their shutdown before calling `runtime.closeDatabase()`, or leave the
client externally owned.

For an owned client, `runtime.closeDatabase({ timeoutMs, signal })` invokes the
callback once after successful completion. Concurrent calls share pending work;
a timeout/abort stops waiting but does not cancel the underlying disconnect.
Failures propagate unchanged and permit an explicit retry. Do not reuse an owned
runtime after disconnect: create a new client/runtime for a new lifecycle. Direct
client queries are not intercepted; stop external producers before disconnecting.

## Scheduling and shutdown

```typescript
import { setTimeout } from 'node:timers/promises';

app.runtime.scheduler.initialize([{
  name: 'refresh-cache', cron: '*/30 * * * * *', overlap: 'skip',
  job: async ({ signal, scheduledAt }) => {
    await setTimeout(100, undefined, { signal });
    app.runtime.logger.info({ scheduledAt }, 'Cache refreshed');
  },
}]);

await app.shutdown({ timeoutMs: 10_000 });
```

`overlap: 'skip'` is the default; `'allow'` permits concurrent invocations. Job names
are unique per scheduler, so separate runtimes can use the same names. Jobs receive
a cancellation signal and a copy of their scheduled date.

`close()` drains HTTP only. `shutdown()` stops HTTP and jobs before closing the
runtime's opt-in disconnect callback, sharing a total default deadline of 30 seconds. Both accept
`{ timeoutMs, signal }`. Timeout/cancellation closes HTTP connections and aborts
request signals. Jobs must cooperate with cancellation; arbitrary JavaScript
cannot be forcibly stopped. If jobs do not finish, shutdown rejects, the database
stays open, and the scheduler rejects new work until they settle.

`res.locals.signal` also aborts on client disconnection. The library does not
install global process signal handlers; connect your own handler to `shutdown()`.

File routers are discovered asynchronously and loaded sequentially in relative-path
order (case-sensitive, with slash-normalized paths). Explicit router arrays keep
their supplied order. Give static routes earlier filenames than conflicting
parameter routes. Declaration files are ignored.

Scheduler initialization returns `ScheduledJob[]` handles with `name`,
`nextInvocation()`, `cancel()` and `invoke(date?)`. The implementation uses Croner;
no dependency-specific job class is exposed. Manual failures reject their promise;
automatic failures are logged.

## Errors and logging

Custom four-argument `errorHandlers` run before the fallback; call `next(error)`
to delegate. Parser errors preserve HTTP 4xx, unexpected failures return 500.
Extend `HttpException` for HTTP-aware application errors:

```typescript
import { HttpException } from '@ireves/common-api';

class EmailTaken extends HttpException {
  constructor() {
    super(409, { code: 'EMAIL_TAKEN', message: 'Email is already in use.' });
  }
}
// In an awaited controller/service path: throw new EmailTaken();
```

The fallback returns `{ error: { code, message }, requestId }` with the actual HTTP
status. `code` is an application-owned string/number (default `HTTP_<status>`).
Messages are public by default for 4xx and hidden for 5xx; use `expose` explicitly
when needed. Stack, cause and arbitrary subclass properties are never serialized
into the response. All fallback 5xx errors, including explicit HttpException
instances, are logged with request context. `cause` stays available in logs.

The library defines no business error catalog or Result type. Domain errors can
extend ordinary Error and be mapped by the existing `errorHandlers` option;
custom handlers run first and may use a completely different response format.
Expected business outcomes may also be returned as values. Exceptions only unwind
the awaited call chain; use client transactions for rollback and explicit
cancellation for parallel work.

`ResponseException` is deprecated and retains its legacy HTTP 200 response
`{ status, message }`. Built-in JWT expiry/invalid-token responses currently keep
that legacy contract. Use HttpException for new code, or map legacy errors in a
custom handler when migrating an application's API.

The default logger writes JSON to stdout. Error logs preserve stacks, causes and
aggregate errors, along with request ID, method and path. `res.locals.log` carries
the ID returned through `X-Request-Id`. No log directory is created on import.
Logging uses Pino: `log.info({ userId }, 'Signed in')`. Use
`createLogger({ destination: stream })` for a caller-owned output stream, or inject
a Pino logger through `createRuntime({ logger })`. File rotation and retention
belong to the application's log collector or transport. Flush logs with
`logger.flush(callback)` before closing custom streams; never close stdout.

## Repository layout

```text
src/
  index.ts              # Package entry and legacy default namespace
  public-api.ts         # Explicit root export contract
  app/                  # Express app creation and HTTP lifecycle
  runtime/              # Typed resource injection and shutdown utilities
  config/               # JWT configuration store
  errors/               # Extensible exception types
  jwt/                  # Token signing, verification and authentication
  middleware/           # Permission composition and error handling
  router/               # Route definitions and module discovery
  logger/               # Pino setup and error serialization
  scheduler/            # Croner integration and job lifecycle
  utils/                # File traversal helpers
test/
  app/ jwt/ middleware/ logger/ router/ runtime/ scheduler/
  package/              # Public imports and compatibility checks
  fixtures/             # Legacy token and typed package consumer
scripts/                # Build cleanup and package verification
```

Feature directories match the public subpaths. Internal files use kebab-case;
source imports point directly to their owning module rather than the root API.
Tests follow the same feature grouping. The test command discovers nested
`*.test.mjs` files; fixtures are not executed as tests. The package consumer fixture
is compiled and run separately against the packed artifact.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run test:package
```

Development uses `tsx watch` with all source TypeScript files included; builds use TypeScript 7 with `NodeNext`. `npm pack` runs
type checking and tests on a fresh build. Only `dist/` and package documentation
are shipped. Package checks extract the tarball and compile/run a typed ESM consumer.

CI covers Node 22.13.0, 24 and 26 on Linux and Windows. Database injection and
shutdown tests use in-memory clients; no live database tests run here. Schema,
migration and real Prisma/database integration tests belong to the service app.
