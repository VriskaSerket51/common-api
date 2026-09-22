export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

export interface Config {
  jwtSecret?: string;
  db?: DatabaseConfig;
}
export type ConfigSnapshot = Readonly<{ jwtSecret?: string; db?: Readonly<DatabaseConfig> }>;

export const validateDatabaseConfig = (db: DatabaseConfig): Readonly<DatabaseConfig> => {
  if (!db || [db.host, db.user, db.database].some(value => typeof value !== "string" || !value.trim())
    || typeof db.password !== "string" || !Number.isInteger(db.port) || db.port < 1 || db.port > 65535
    || (db.connectionLimit !== undefined && (!Number.isInteger(db.connectionLimit) || db.connectionLimit < 1))) {
    throw new Error("Invalid database configuration.");
  }
  return Object.freeze({ host: db.host, port: db.port, user: db.user, password: db.password,
    database: db.database, connectionLimit: db.connectionLimit ?? 10 });
};

export const createConfigStore = (initial?: Config) => {
  let config: ConfigSnapshot | undefined;
  const initialize = (next: Config): void => {
    if (!next || (next.jwtSecret === undefined && next.db === undefined)) {
      throw new Error("Configure at least JWT or database features.");
    }
    if (next.jwtSecret !== undefined && (typeof next.jwtSecret !== "string" || !next.jwtSecret.trim()
      || next.jwtSecret === "jwtSecret")) {
      throw new Error("jwtSecret must be explicitly configured and must not use the old default key.");
    }
    config = Object.freeze({
      ...(next.jwtSecret !== undefined ? { jwtSecret: next.jwtSecret } : {}),
      ...(next.db !== undefined ? { db: validateDatabaseConfig(next.db) } : {}),
    });
  };
  const get = (): ConfigSnapshot => {
    if (!config) throw new Error("Call initializeConfig() before using JWT or database features.");
    return config;
  };
  const jwtSecret = (): string => {
    const value = get().jwtSecret;
    if (!value) throw new Error("JWT is not configured.");
    return value;
  };
  const database = (): Readonly<DatabaseConfig> => {
    const value = get().db;
    if (!value) throw new Error("Database is not configured.");
    return value;
  };
  const update = (patch: Partial<Config>): void => initialize({ ...get(), ...patch });
  if (initial) initialize(initial);
  return { initialize, update, get, jwtSecret, database, snapshot: () => config };
};

export type ConfigStore = ReturnType<typeof createConfigStore>;
export const defaultConfigStore = createConfigStore();
export const initializeConfig = defaultConfigStore.initialize;
export const getConfig = defaultConfigStore.get;
export const updateConfig = defaultConfigStore.update;
