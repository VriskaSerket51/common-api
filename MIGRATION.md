# Migrating from 1.x

## Setup

1. Use Node.js 22.13+ and add `"type": "module"`.
2. Use `.js` extensions for relative imports with `NodeNext`.
3. Check [Express 5 route syntax](https://expressjs.com/en/guide/migrating-5/): `/*` becomes `/{*splat}`, `/:file.:ext?` becomes `/:file{.:ext}`.

## App

Replace `new CommonApi.App(...)` with `await App.create({ ... })` and `app.run()` with `await app.listen(port)`.

The options form creates a separate runtime. Pass the same `runtime` to share services. Positional `App.create(...)` and module-level helpers keep the old shared runtime.

File discovery and `createRouterByFiles()` now return promises. Router files load in sorted relative-path order; check overlapping routes.

## JWT

- Add `await` to token creation and verification. Replace callbacks with `try`/`catch`.
- Import `JwtSignOptions` and `JwtVerifyOptions` from common-api, not jsonwebtoken.
- Only HS256 is supported. Old HS256 tokens work with the same UTF-8 key; the old default secret is rejected.
- Durations take seconds or strings such as `'10m'`. Unitless strings and unsupported signing options are rejected.
- Claims are in `res.locals.auth`. Permission routes need an access token and a `permissionChecker`.
- Optional auth allows missing tokens, not invalid tokens.

## Database

The built-in MySQL driver and SQL helpers were removed. See the [client example](README.md#database).

| Old API | Replacement |
| --- | --- |
| `Config.db`, `DatabaseConfig`, `validateDatabaseConfig`, `config.database()` | Client configuration in your app |
| `createDatabase`, `defaultDatabase`, `Database` | `createRuntime({ database })` |
| `query`, `execute`, `getAllAsync`, `getFirstAsync`, `runAsync` | Client queries |
| `withTransaction`, `connection` | Client transaction API |
| `database.closeDatabase`, module-level `closeDatabase` | `runtime.closeDatabase()` with a disconnect callback |
| `MySqlException` | Client errors |

Update code that expects mysql2 result tuples. Pass `disconnectDatabase` only if the runtime should close the client.

## Jobs and shutdown

- `close()` waits for HTTP only. `shutdown()` also stops jobs and closes the owned DB.
- Both take `{ timeoutMs, signal }`. Default timeout: 30 seconds total.
- Jobs receive `{ signal, scheduledAt }` and skip overlap unless `overlap: 'allow'` is set.
- Jobs must handle cancellation. If a job times out, the DB stays open; retry shutdown after it finishes.
- Scheduling uses Croner. Replace node-schedule events and `reschedule()` with cancellation and a new schedule. Jobs are not persisted.

## Errors and logs

Use `HttpException(status, { code, message, cause, expose })` for HTTP errors. The body is `{ error: { code, message }, requestId }`. 4xx messages are shown by default; 5xx messages are hidden. Custom `errorHandlers` run first.

`ResponseException` still returns HTTP 200 with `{ status, message }`. JWT errors return HTTP 401 with `TOKEN_EXPIRED` or `TOKEN_INVALID`.

Logging uses Pino. Change `log.info('Message', { data })` to `log.info({ data }, 'Message')`. Replace `logDir` and Winston transports with a stream or Pino logger. Flush custom loggers before closing their streams; do not close stdout.

## Imports

Use named imports from `@ireves/common-api`. Feature paths: `/app`, `/runtime`, `/config`, `/errors`, `/logger`, `/jwt`, `/middleware`, `/router`, `/scheduler`, `/utils`.

The default namespace import is deprecated. Do not import internal source or `dist/` files.
