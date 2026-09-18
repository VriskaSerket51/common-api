# common-api

Simple backend framework with JWT and MySQL support.

## Installation into an existing project

To install `common-api` as a dependency of your Node.js project:

```sh
npm install @ireves/common-api
```

`common-api` is made with TypeScript.

## Runtime and dependency migration

Node.js 22.13.0 or later is required. The package emits native ES modules.
Use `import CommonApi from "@ireves/common-api"` or named imports, and set
`"type": "module"` in your application's `package.json`.

Replace `new CommonApi.App(...)` with `await CommonApi.App.create(...)`.
File routers are loaded with asynchronous `import()`, including modules with
top-level await. `createRouterByFiles(...)` now also returns a promise.
Initialization failures reject before the application is returned.

Relative imports must include the output extension, for example
`import { UserRouter } from "./users.js"` in TypeScript source. Router directories
support `.js`, `.mjs`, `.ts`, and `.mts`; declaration files are excluded. Run
TypeScript routers through `tsx` during development and load compiled JavaScript
in production. See the [Node.js ESM documentation](https://nodejs.org/api/esm.html).

This version uses Express 5. Applications upgrading from Express 4 should review
the [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5/),
especially route path syntax (`/*splat` or `/{*splat}` instead of `/*`, and
`/:file{.:ext}` instead of `/:file.:ext?`) and changes to request query/body handling.
Rejected promises from async controllers are handled by Express directly.

Development uses `tsx` through `npm run dev`, and `npm run build` emits JavaScript
and declarations using TypeScript 7 with `NodeNext` module resolution. Run
`npm run typecheck` for type checking and `npm test` for the migration checks.

## How to use

Create an application with named options. Routers can be plain objects or
instances of `RouterBase` subclasses; both use the same `models` definitions.

```typescript
import { App, type RouterDefinition } from "@ireves/common-api";

const healthRouter = {
    path: "/health",
    models: [{
        method: "get",
        path: "/",
        middlewares: [(_req, res, next) => {
            res.setHeader("Cache-Control", "no-store");
            next();
        }],
        controller: (_req, res) => res.json({ status: "ok" }),
    }],
} satisfies RouterDefinition;

const app = await App.create({
    routers: [healthRouter],
    cors: { origin: "https://example.com" },
});

const server = await app.listen({ port: 3000, host: "127.0.0.1" });
console.info("Server listening:", server.address());

// When shutting down, stop accepting connections and finish active requests:
// await app.close();
```

- `App.create()` also works without options. `routerDir` optionally discovers
  file routers; when combined with `routers`, explicitly supplied routers run first.
- Default authentication middleware runs before each route's `middlewares`.
  Set `authType: "access"` or `"refresh"` to require authentication.
- `routerMiddleware` replaces the default route middleware factory. Use
  `createRouterMiddlewares(checkPermission)` when a route declares `permission`.
  Without a checker, permission-protected routes fail during initialization.
  These routes always require an access token; `optional` and `refresh` are
  rejected as incompatible authentication modes.
- `errorHandlers` accepts Express error handlers with four arguments and runs
  them before the built-in fallback. Call `next(error)` to delegate.
- CORS defaults to the existing permissive behavior. Set `cors: false` to disable
  CORS middleware or provide CORS options to configure it.
- `listen()` returns the HTTP server and rejects on startup errors. Call
  `close()` before restarting; repeated close calls are safe. Shutdown waits for
  active HTTP requests, so long-lived streams must be ended by your application.
  Database connections and scheduler jobs remain managed separately.
- Positional `App.create(routerDir, middlewares, routerMiddleware, errorHandlers)`
  and callback-based `run()` remain available but are deprecated.

For file discovery instead of explicit routers:

```javascript
import { App } from "@ireves/common-api";
import { fileURLToPath } from "node:url";

const app = await App.create({
    routerDir: fileURLToPath(new URL("./router/", import.meta.url)),
});
await app.listen(3000);
```

Initialize JWT/database configuration before using those features:

```typescript
import CommonApi from "@ireves/common-api";

const config: CommonApi.Config = {
    jwtSecret: process.env.JWT_SECRET!,
    db: {
        host: "127.0.0.1",
        port: 3306,
        user: "root",
        password: "password",
        database: "db",
    },
};

CommonApi.initializeConfig(config);
```

```typescript
const schedules: CommonApi.Schedule[] = [{
    name: "testSchedule",
    cron: "00 00 00 * * *",
    job: () => {
        console.log("Welcome!")
    },
}];
CommonApi.initializeScheduler(schedules);
```

JWT and database helpers now reject use before `initializeConfig()`. Empty keys
and the old `jwtSecret` default are rejected. Database configuration is validated
and copied so caller mutations do not silently change the active configuration.

Verified JWT claims are available as `res.locals.auth`. Optional authentication
allows missing credentials, but rejects malformed, expired, or invalid credentials.
Token creation does not mutate the supplied signing options.

## Permission policies

Numeric permissions have no built-in ordering or bitmask semantics. Supply your
application's policy explicitly. For example, if your signed access tokens contain
an array of granted permission IDs:

```typescript
import { App, createRouterMiddlewares } from "@ireves/common-api";

const app = await App.create({
    routerMiddleware: createRouterMiddlewares((permission, _req, res) => {
        const grants: unknown = res.locals.auth?.permissions;
        return Array.isArray(grants) && grants.includes(permission);
    }),
    routers: [{ path: "/admin", models: [{
        method: "get",
        path: "/",
        permission: 7,
        controller: (_req, res) => res.json({ user: res.locals.auth?.sub }),
    }] }],
});
```

The checker may return a promise. A false result returns HTTP 403. It runs after
JWT verification and before route-specific middleware. Applications that replace
the middleware factory entirely are responsible for implementing their own policy.

## Database and scheduler lifecycle

Query helpers reuse a lazy MySQL pool (10 connections by default). Set
`db.connectionLimit` to adjust it. `connection()` still opens a dedicated
connection, which the caller must close with `end()`.

Use the supplied connection for every statement inside a transaction:

```typescript
import { withTransaction } from "@ireves/common-api";

await withTransaction(async (connection) => {
    await connection.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", [10, 1]);
    await connection.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", [10, 2]);
});
```

Success commits; failure rolls back and releases the connection. Failed rollback
discards the connection and reports both errors. Call `closeDatabase()` before
using a new configuration after a pool has been created.

Scheduled jobs may return `Promise<void>`. Failures are logged, job dates are not
mutated, and initialization returns job handles. Names must be unique and invalid
cron expressions reject initialization, canceling jobs created by that batch.

Stop work producers before closing the database pool:

```typescript
import { shutdownScheduler, closeDatabase } from "@ireves/common-api";

await Promise.all([app.close(), shutdownScheduler()]);
await closeDatabase();
```

`shutdownScheduler()` cancels this library's schedules and waits for running jobs.
