export type Config = {
  jwtSecret: string;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit?: number;
  };
};

let config: Readonly<Omit<Config, "db">> & { readonly db: Readonly<Config["db"]> } | undefined;

export const getConfig = () => {
  if (!config) throw new Error("Call initializeConfig() before using JWT or database features.");
  return config;
};

export const initializeConfig = (newConfig: Config): void => {
  if (!newConfig || typeof newConfig.jwtSecret !== "string" || !newConfig.jwtSecret.trim()
    || newConfig.jwtSecret === "jwtSecret") {
    throw new Error("jwtSecret must be explicitly configured and must not use the old default key.");
  }
  const db = newConfig.db;
  if (!db || [db.host, db.user, db.database].some(value => typeof value !== "string" || !value.trim())
    || typeof db.password !== "string" || !Number.isInteger(db.port) || db.port < 1 || db.port > 65535
    || (db.connectionLimit !== undefined && (!Number.isInteger(db.connectionLimit) || db.connectionLimit < 1))) {
    throw new Error("Invalid database configuration.");
  }
  config = Object.freeze({ jwtSecret: newConfig.jwtSecret, db: Object.freeze({ ...db }) });
};
