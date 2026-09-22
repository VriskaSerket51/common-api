import legacy, * as rootApi from '@ireves/common-api';
import { App, type AppOptions, type ShutdownOptions } from '@ireves/common-api/app';
import { createRuntime, type RuntimeOptions } from '@ireves/common-api/runtime';
import { createConfigStore, type Config } from '@ireves/common-api/config';
import { HttpException, type HttpExceptionOptions } from '@ireves/common-api/errors';
import { createLogger, type LoggerOptions } from '@ireves/common-api/logger';
import { createJwt, type JwtSignOptions } from '@ireves/common-api/jwt';
import { createRouterMiddlewares, type ErrorMiddleware } from '@ireves/common-api/middleware';
import { createRouter, defineRoutes, type ModelBase, type RoutesFactory, type RouteServices } from '@ireves/common-api/router';
import { createScheduler, type ScheduledJob } from '@ireves/common-api/scheduler';
import { readAllFilesAsync } from '@ireves/common-api/utils';
const config: Config = { jwtSecret: 'consumer-key' };
const logOptions: LoggerOptions = { silent: true };
const signOptions: JwtSignOptions = { expiresIn: '1m' };
const errorOptions: HttpExceptionOptions = { code: 'CONSUMER', message: 'Consumer error' };
const shutdownOptions: ShutdownOptions = { timeoutMs: 1000 };
const errorMiddleware: ErrorMiddleware = (error, _req, _res, next) => next(error);
if (legacy.App !== App || rootApi.HttpException !== HttpException) throw new Error('Export identity mismatch');
const featureLogger = createLogger(logOptions);
const featureJwt = createJwt(createConfigStore(config).jwtSecret);
await featureJwt.verifyJwt(await featureJwt.createAccessToken({}, signOptions));
createRouter([], createRouterMiddlewares(undefined, featureJwt));
await createScheduler(featureLogger).shutdown(shutdownOptions);
if (!(new HttpException(409, errorOptions) instanceof rootApi.HttpException)) throw new Error('Error identity mismatch');
if (typeof readAllFilesAsync !== 'function') throw new Error('Missing utils export');
const route: ModelBase = { method: 'get', path: '/', controller: (_req, res) => res.sendStatus(200) };
const options: AppOptions = { routers: [{ path: '/', models: [route] }], config: { jwtSecret: 'package-test-key' } };
const app = await App.create(options);
const token = await app.runtime.jwt.createAccessToken({ sub: 'package-user' });
const claims = await app.runtime.jwt.verifyJwt(token);
if (claims.sub !== 'package-user') throw new Error('JWT consumer check failed');
const jobs: ScheduledJob[] = app.runtime.scheduler.initialize([{ name: 'consumer', cron: '0 0 1 1 *', job: () => {} }]);
if (jobs[0]?.name !== 'consumer') throw new Error('Scheduler consumer check failed');
await app.shutdown();
app.runtime.logger.flush();
const noDatabase: undefined = app.runtime.database;
let disconnected = 0;
const client = {
  user: { async findMany() { return [{ id: 1, email: 'typed@example.test' }]; } },
  async $disconnect() { disconnected++; },
};
const runtimeOptions: RuntimeOptions<typeof client> = {
  database: client, disconnectDatabase: db => db.$disconnect(),
};
const runtime = createRuntime(runtimeOptions);
const typedOptions: AppOptions<typeof client> = { runtime };
const typedApp = await App.create(typedOptions);
const inferred = createRuntime({ database: client, disconnectDatabase: db => db.$disconnect() });
const routes: RoutesFactory<typeof client> = defineRoutes(({ database }) => [{
  path: '/users', models: [{ method: 'get', path: '/', controller: async (_req, res) => {
    const users: { id: number; email: string }[] = await database.user.findMany();
    res.json(users);
  } }],
}]);
const factoryApp = await App.create({ runtime, routers: routes });
const contextualApp = await App.create({ runtime, routers: context => {
  const db: typeof client = context.database;
  if (false) {
    // @ts-expect-error: contextual inference must not erase database types.
    context.database.missingModel.findMany();
    // @ts-expect-error: lifecycle belongs to the app, not route dependencies.
    context.closeDatabase();
    // @ts-expect-error: service references cannot be reassigned by a route.
    context.database = client;
  }
  return [];
} });
const databaseOnly = ({ database }: Pick<RouteServices<typeof client>, 'database'>): readonly rootApi.RouterDefinition[] => [{
  path: '/minimal', models: [{ method: 'get', path: '/', controller: async (_req, res) => res.json(await database.user.findMany()) }],
}];
const composedApp = await App.create({ runtime, routers: async services => [
  ...await routes(services), ...databaseOnly(services),
] });
databaseOnly({ database: client }); // No App or JWT service required for a unit test.
const rows: { id: number; email: string }[] = await typedApp.runtime.database.user.findMany();
if (rows[0]?.id !== 1 || inferred.database !== client) throw new Error('Database injection consumer check failed');
function rejectInvalidTypes() {
  // @ts-expect-error: missing models must remain type errors, not become any.
  runtime.database.missingModel.findMany();
  // @ts-expect-error: client types must survive App.create.
  typedApp.runtime.database.user.nonexistentMethod();
  // @ts-expect-error: a DB-typed app must receive a matching runtime.
  const missingRuntime: AppOptions<typeof client> = {};
  // @ts-expect-error: no global database exists for an unconfigured app.
  app.runtime.database.user.findMany();
  // @ts-expect-error: database configuration is owned by the application.
  createRuntime({ config: { db: {} } });
}
await typedApp.shutdown();
await typedApp.shutdown();
if (disconnected !== 1) throw new Error('Database lifecycle consumer check failed');
