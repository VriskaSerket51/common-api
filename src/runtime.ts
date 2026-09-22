import { createConfigStore, defaultConfigStore, type Config } from "./config/index.js";
import { createJwt, defaultJwt } from "./middlewares/jwt.js";
import { createDatabase, defaultDatabase } from "./mysql/index.js";
import { createScheduler, defaultScheduler } from "./scheduler/index.js";
import { createLogger, logger, type LoggerOptions } from "./logger/index.js";
import type { Logger } from "winston";

export interface RuntimeOptions {
  config?: Config;
  logger?: Logger;
  logging?: LoggerOptions;
}

/** Independent configuration, credentials, database pool, jobs and logger. */
export const createRuntime = (options: RuntimeOptions = {}) => {
  const config = createConfigStore(options.config);
  const log = options.logger ?? createLogger(options.logging);
  return {
    config, logger: log,
    jwt: createJwt(config.jwtSecret),
    database: createDatabase(config.database),
    scheduler: createScheduler(log),
  };
};

export type Runtime = ReturnType<typeof createRuntime>;
/** Compatibility context for the existing module-level helper functions. */
export const defaultRuntime: Runtime = {
  config: defaultConfigStore, logger, jwt: defaultJwt,
  database: defaultDatabase, scheduler: defaultScheduler,
};
