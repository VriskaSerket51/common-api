# Migrating to 2.0.0

2.0 changes the module format, runtime requirements and application creation API.
Do not publish these changes as a 1.x patch release.

## Runtime and modules

- Node.js 22.13.0+ is required. CI covers 22.13.0, 24 and 26 on Linux and Windows.
- This is an ESM package. Set `"type": "module"` in your project and import
  `@ireves/common-api`. CommonJS consumers must use asynchronous `import()`.
- Relative TypeScript imports use the emitted `.js` extension with `NodeNext`.
- Express 5 changes route syntax: use `/{*splat}` instead of `/*`, and
  `/:file{.:ext}` instead of `/:file.:ext?`. Review the
  [Express migration guide](https://expressjs.com/en/guide/migrating-5/).
- Development uses `tsx`, replacing `ts-node`; builds use TypeScript 7.

## App creation and isolation

Replace `new CommonApi.App(...)` with `await App.create({ ... })`. File loading is
asynchronous; `createRouterByFiles()` also returns a promise. Declaration files
are excluded from discovery.

```ts
import { App } from '@ireves/common-api';
import { fileURLToPath } from 'node:url';

const app = await App.create({
  config: { jwtSecret: process.env.JWT_SECRET! },
  routerDir: fileURLToPath(new URL('./router/', import.meta.url)),
});
await app.listen(3000);
```

The options-object API creates an independent runtime by default. Existing global
configuration, if initialized, is copied at creation; later global changes do not
affect the app. Use `app.runtime.config`, `.jwt`, `.database`, `.scheduler`, and
`.logger` to access its services.

Use `createRuntime({ config, logger })` and `App.create({ runtime })` for explicit
injection. Passing the same runtime to multiple apps deliberately shares resources.
The deprecated positional `App.create(dir, ..., ...)` keeps the shared legacy
runtime, as do module-level helpers. `defaultRuntime` provides explicit compatibility.

## Configuration and authentication

JWT now uses `jose` instead of `jsonwebtoken`:

```ts
const token = await app.runtime.jwt.createAccessToken({ sub: 'user-1' });
const claims = await app.runtime.jwt.verifyJwt(token);
```

Add `await` to token creation and replace verification callbacks with `await` /
`try` / `catch`. Import `JwtSignOptions` and `JwtVerifyOptions` from this package
instead of `jsonwebtoken` types. Direct verification rejects with `jose` errors
(for example `ERR_JWT_EXPIRED`); HTTP middleware keeps application codes -100 and
-101. Only HS256 is enabled. Older HS256 tokens remain valid with the same UTF-8
secret, subject to expiration and supplied claim checks.

Supported signing options: `expiresIn`, `notBefore`, `issuer`, `audience`,
`subject`, `jwtid`, `noTimestamp`, `algorithm: 'HS256'`. Unsupported options reject
instead of being silently ignored. Durations accept seconds or strings ending in
`s`, `m`, `h`, `d`, `w`; replace unitless strings and long-form durations with these
forms. Explicit payload `exp`/`jti` values are preserved when the corresponding
options are absent; specifying the same claim in both places rejects.

- JWT configuration and database injection are independently optional. JWT use
  without a configured key throws; an uninjected database is undefined.
- `initializeConfig()`/`runtime.config.initialize()` replaces configuration.
  `updateConfig()`/`runtime.config.update()` merges a partial update.
- Database credentials and connection pools belong to the injected client.
  Rotating JWT configuration does not replace that client.
- Verified claims live in `res.locals.auth`. Optional authentication allows missing
  credentials, but rejects invalid credentials.
- Routes with `permission` require a checker. Use the app's `permissionChecker`
  option, or `createRouterMiddlewares(checker, runtime.jwt)` for custom composition.
  Permission routes require access tokens. Numeric values have no implicit ordering.
- Legacy `ResponseException` still uses HTTP 200 with an application status code.

## Database ownership and Prisma

The built-in mysql2 driver, lazy pool and SQL helper layer have been removed.
The package does not require Prisma: inject your application's configured Prisma
client (or another DB client) through `createRuntime({ database: prisma })`.
Prisma schemas, generated artifacts, migrations, adapter configuration and client
creation remain in the service repository; see the README injection example.

| Removed API | Replacement |
| --- | --- |
| `Config.db`, `DatabaseConfig`, `validateDatabaseConfig`, `config.database()` | Configure the application's client directly. Legacy `config.db` now throws. |
| `createDatabase`, `defaultDatabase`, `Database` | `createRuntime({ database: client })`; no global database. |
| `query`, `execute`, `getAllAsync`, `getFirstAsync`, `runAsync` | Client model queries or its parameterized raw SQL API. |
| `withTransaction`, `connection` | Client transaction API (Prisma `$transaction`); redesign direct-connection code. |
| `database.closeDatabase`, module-level `closeDatabase` | `runtime.closeDatabase` with an explicit `disconnectDatabase` callback. |
| `MySqlException` | Original client errors; optionally wrap in `Exception(message, { cause })`. |

`runtime.database` is the original client, not a wrapper. Query result shapes,
insert IDs and transaction connections are no longer mysql2 contracts. Update
callers to use their ORM's results and transaction-scoped client.

Use `disconnectDatabase: client => client.$disconnect()` to transfer disconnect
responsibility to one runtime. Omit it for a shared client and close that client
only after every application and background producer has stopped. Shutdown never
auto-detects `$disconnect`. Successful disconnect is once per runtime; create a new
runtime/client before restarting DB work. Rejected disconnects can be retried;
timeouts/aborts do not cancel underlying work and later calls await the same work.
A previously aborted signal prevents starting a disconnect. Client queries outside
this framework are not tracked or blocked automatically.

`Runtime<TClient>`, `RuntimeOptions<TClient>`, `App<TClient>` and
`AppOptions<TClient>` preserve the supplied type. Without injection, the database
is typed as undefined. Defaults/global compatibility runtimes hold no DB client.

## Shutdown and scheduled work

- `await app.listen(...)` returns an HTTP server; `run()` remains deprecated.
- `await app.close({ timeoutMs, signal })` closes HTTP only, with a default 30-second
  deadline. Timeout/cancellation aborts request signals, closes connections and
  rejects; it does not claim request handlers have stopped.
- `await app.shutdown({ timeoutMs, signal })` stops HTTP and scheduled jobs before
  calling its opt-in database disconnect callback, sharing a total 30-second budget.
- Jobs receive `{ signal, scheduledAt }`. Shutdown cancels future invocations and
  aborts active job signals. Jobs must cooperate to actually stop running.
- A timed-out job leaves shutdown rejected and the database open. The scheduler
  refuses new work until outstanding jobs settle. Retry shutdown after they finish.
  JavaScript code is never forcibly terminated.
- Overlap defaults to `overlap: 'skip'`. Select `'allow'` to preserve concurrent
  behavior. Names are unique within a scheduler, not across all runtimes.
- Transactions and direct connections are managed by your database client.

## Logging and packaging

The default logger emits JSON to stdout, without creating a directory on import.
Logging now uses Pino. Request failures
include request ID, method, path, stack and nested causes. `res.locals.log` carries
the ID returned in `X-Request-Id`; `res.locals.signal` signals disconnection or
forced shutdown. Logger lifecycle belongs to the application that supplied it.

- Injected loggers must be Pino loggers. Change `log.info('message', { data })`
  to `log.info({ data }, 'message')`; metadata comes first.
- Records use Pino's numeric `level`, `time` and `msg` fields. Error details
  remain in `error` (or `err` for direct Error logging), including nested causes.
- `logDir`, `console` and Winston `transports` options are removed. Use
  `createLogger({ destination: stream })`, `silent: true`, or inject a configured
  Pino logger. Daily rotation, compression and retention are managed externally.
- Pino loggers have no `close()`/`end()`. Await `logger.flush(callback)` and
  then end caller-owned streams/transports. Do not end stdout.
- UUID v4 uses Node's `randomUUID()`. Development uses `tsx watch`; build
  cleanup uses `fs.rm` with Windows retries. Node types track the 22.x runtime family.

`npm pack` runs type checking and tests against a fresh build. Only `dist/` and
package documentation are shipped. `npm run test:package` checks the tarball and
compiles/runs a typed ESM consumer against its contents.

Live MySQL tests and their CI service were removed along with the built-in driver.
Injection/lifecycle tests run without a DB. Real integration and migration tests
now belong to the service that owns the schema and client.

## Scheduler, routing and stricter types

- Scheduling uses Croner. Initialization returns our `ScheduledJob[]` handles,
  exposing `name`, `nextInvocation()`, `cancel()` and async `invoke(date?)`.
  Raw node-schedule Job events and `reschedule()` are no longer exposed. Cancel
  and initialize a new schedule instead. Active jobs must settle before reusing
  their name. Manual invocation rejections are logged and propagated to the caller;
  timer invocation failures are logged and contained. Cancellation stops future
  invocations; scheduler shutdown also signals active jobs and drains them.
- Existing five/six-field cron schedules remain supported. Croner has its own
  extended syntax; check unusual expressions when migrating. A schedule with no
  future execution is rejected. Jobs remain in-process and non-durable.
- File routers now use asynchronous traversal, sorted by slash-normalized relative
  path in case-sensitive code-unit order. This can change precedence between
  overlapping file routes; rename files or use explicit ordered definitions.
  The existing synchronous `readAllFiles` helper remains available;
  `readAllFilesAsync` returns a sorted array without modifying an input array.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are enabled.
- CI runs the package check once per matrix entry; its prepack hook still runs
  type checking and the complete unit suite before the consumer check.
