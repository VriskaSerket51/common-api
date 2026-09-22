import { createConfigStore, defaultConfigStore, type Config } from "../config/index.js";
import { createJwt, defaultJwt } from "../jwt/index.js";
import { createScheduler, defaultScheduler } from "../scheduler/index.js";
import { createLogger, logger, type LoggerOptions } from "../logger/index.js";
import { waitForShutdown, validateShutdownOptions, type ShutdownOptions } from "./shutdown.js";
import type { Logger } from "pino";

interface RuntimeBaseOptions {
  config?: Config;
  logger?: Logger;
  logging?: LoggerOptions;
}

/** Database ownership is opt-in; omitting disconnectDatabase leaves it caller-owned. */
export type RuntimeOptions<TDatabase = undefined> = RuntimeBaseOptions & (
  [TDatabase] extends [undefined]
    ? { database?: TDatabase; disconnectDatabase?: never }
    : { database: TDatabase; disconnectDatabase?: (database: TDatabase) => void | Promise<void> }
);

export interface Runtime<TDatabase = undefined> {
  readonly config: ReturnType<typeof createConfigStore>;
  readonly logger: Logger;
  readonly jwt: ReturnType<typeof createJwt>;
  readonly database: TDatabase;
  readonly scheduler: ReturnType<typeof createScheduler>;
  /** Drains the opt-in disconnect callback; does not proxy or guard client queries. */
  closeDatabase(options?: ShutdownOptions): Promise<void>;
}

export function createRuntime<TDatabase>(options: RuntimeOptions<TDatabase>): Runtime<TDatabase>;
export function createRuntime(options?: RuntimeOptions): Runtime;
export function createRuntime<TDatabase>(options: RuntimeBaseOptions & {
  database?: TDatabase;
  disconnectDatabase?: (database: TDatabase) => void | Promise<void>;
} = {}): Runtime<TDatabase | undefined> {
  const config = createConfigStore(options.config);
  const log = options.logger ?? createLogger(options.logging);
  const database = options.database;
  // Capture ownership once; mutations to the options object must not change it.
  const disconnect = options.disconnectDatabase;
  if (disconnect && database === undefined) throw new TypeError("disconnectDatabase requires a database client.");
  let closing: Promise<void> | undefined;
  const closeDatabase = (shutdown: ShutdownOptions = {}): Promise<void> => {
    validateShutdownOptions(shutdown);
    if (shutdown.signal?.aborted) return Promise.reject(new Error("Shutdown was aborted.", { cause: shutdown.signal.reason }));
    if (!disconnect || database === undefined) return Promise.resolve();
    if (!closing) {
      closing = Promise.resolve().then(() => disconnect(database)).catch(error => {
        closing = undefined; // Failed disconnects can be explicitly retried.
        throw error;
      });
    }
    // Keep a successful/in-flight promise: repeated calls must not disconnect twice.
    return waitForShutdown(closing, shutdown);
  };
  return {
    config, logger: log, jwt: createJwt(config.jwtSecret), database,
    scheduler: createScheduler(log), closeDatabase,
  };
}

/** Compatibility context for module-level JWT/configuration/scheduling helpers. No DB is stored globally. */
export const defaultRuntime: Runtime = {
  config: defaultConfigStore, logger, jwt: defaultJwt, database: undefined,
  scheduler: defaultScheduler,
  closeDatabase: async (options = {}) => {
    validateShutdownOptions(options);
    if (options.signal?.aborted) throw new Error("Shutdown was aborted.", { cause: options.signal.reason });
  },
};

export type { ShutdownOptions } from "./shutdown.js";
