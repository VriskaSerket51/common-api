# common-api

Simple backend framework with JWT and scheduling support.

## Installation into an existing project

```sh
npm install @ireves/common-api
```

`common-api` is made with TypeScript. Node.js 22.13+ and `"type": "module"` are required.

## How to use

```ts
import { App } from '@ireves/common-api';

const app = await App.create({
  routers: [{
    path: '/health',
    models: [{
      method: 'get', path: '/',
      controller: (_req, res) => res.json({ status: 'ok' }),
    }],
  }],
});

await app.listen(3000);
```

Router files can also be loaded with `App.create({ routerDir })`. Use compiled JavaScript files in production.

### JWT

Set `config.jwtSecret` when creating the app, then use `app.runtime.jwt`:

```ts
const token = await app.runtime.jwt.createAccessToken({ sub: 'user-1' });
const claims = await app.runtime.jwt.verifyJwt(token);
```

Use a random HS256 secret of at least 32 bytes. Default token lifetimes: access 10 minutes, refresh 6 hours.

For protected routes, set `authType: 'access'`. Claims are available in `res.locals.auth`. Routes with `permission` also need a `permissionChecker` in the app options.

### Database

Pass your own database client:

```ts
import { createRuntime } from '@ireves/common-api';
import { prisma } from './database.js';

const runtime = createRuntime({
  database: prisma,
  disconnectDatabase: client => client.$disconnect(),
});
const app = await App.create({ runtime });
```

Use `runtime.database` for queries. Schemas and migrations stay in your app. Leave out `disconnectDatabase` for shared clients.

### Scheduling

```ts
app.runtime.scheduler.initialize([{
  name: 'daily-job',
  cron: '0 0 * * *',
  job: async ({ signal }) => {
    // Your job here. Handle signal cancellation for long-running work.
  },
}]);
```

Call `await app.shutdown()` to stop HTTP, jobs and the owned database. Default timeout: 30 seconds.

## Development

```sh
npm ci
npm test
npm run test:package
```

For 1.x upgrades, see [MIGRATION.md](MIGRATION.md).
