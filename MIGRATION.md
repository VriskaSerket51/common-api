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

- JWT and DB configuration are independently optional. Accessing a disabled feature
  throws a descriptive error. No default signing key or database password is provided.
- `initializeConfig()`/`runtime.config.initialize()` replaces configuration.
  `updateConfig()`/`runtime.config.update()` merges a partial update.
- Reapplying equal DB values or rotating only a JWT key preserves the pool. For
  changed DB connection values, finish work and close the old pool first.
- Verified claims live in `res.locals.auth`. Optional authentication allows missing
  credentials, but rejects invalid credentials.
- Routes with `permission` require a checker. Use the app's `permissionChecker`
  option, or `createRouterMiddlewares(checker, runtime.jwt)` for custom composition.
  Permission routes require access tokens. Numeric values have no implicit ordering.
- Legacy `ResponseException` still uses HTTP 200 with an application status code.

## Shutdown and scheduled work

- `await app.listen(...)` returns an HTTP server; `run()` remains deprecated.
- `await app.close({ timeoutMs, signal })` closes HTTP only, with a default 30-second
  deadline. Timeout/cancellation aborts request signals, closes connections and
  rejects; it does not claim request handlers have stopped.
- `await app.shutdown({ timeoutMs, signal })` stops HTTP and scheduled jobs before
  closing that runtime's pool, sharing a total 30-second default budget.
- Jobs receive `{ signal, scheduledAt }`. Shutdown cancels future invocations and
  aborts active job signals. Jobs must cooperate to actually stop running.
- A timed-out job leaves shutdown rejected and the database open. The scheduler
  refuses new work until outstanding jobs settle. Retry shutdown after they finish.
  JavaScript code is never forcibly terminated.
- Overlap defaults to `overlap: 'skip'`. Select `'allow'` to preserve concurrent
  behavior. Names are unique within a scheduler, not across all runtimes.
- SQL helpers use a lazy pool. Transactions must use their supplied connection.
  Dedicated `connection()` callers still close their own connections with `end()`.

## Logging and packaging

The default logger emits JSON to stdout, without creating a directory on import.
Use `createLogger({ logDir: 'logs' })` for optional daily files. Request failures
include request ID, method, path, stack and nested causes. `res.locals.log` carries
the ID returned in `X-Request-Id`; `res.locals.signal` signals disconnection or
forced shutdown. Logger lifecycle belongs to the application that supplied it.

`npm pack` runs type checking and tests against a fresh build. Only `dist/` and
package documentation are shipped. `npm run test:package` checks the tarball and
compiles/runs a typed ESM consumer against its contents.

Real MySQL tests are optional and disabled for push/PR CI. Enable the `mysql`
input manually in CI or run `npm run test:integration` against an explicitly
configured disposable database. They were not run as part of this migration.
