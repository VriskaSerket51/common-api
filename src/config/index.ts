export interface Config {
  jwtSecret?: string;
}
export type ConfigSnapshot = Readonly<Config>;

export const createConfigStore = (initial?: Config) => {
  let config: ConfigSnapshot | undefined;
  const initialize = (next: Config): void => {
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new TypeError("Configuration must be an object.");
    if ("db" in next) throw new Error("config.db was removed. Inject a database client through createRuntime({ database }).");
    if (next.jwtSecret !== undefined && (typeof next.jwtSecret !== "string" || !next.jwtSecret.trim()
      || next.jwtSecret === "jwtSecret")) {
      throw new Error("jwtSecret must be explicitly configured and must not use the old default key.");
    }
    config = Object.freeze({ ...(next.jwtSecret !== undefined ? { jwtSecret: next.jwtSecret } : {}) });
  };
  const get = (): ConfigSnapshot => {
    if (!config) throw new Error("Call initializeConfig() before using JWT features.");
    return config;
  };
  const jwtSecret = (): string => {
    const value = get().jwtSecret;
    if (!value) throw new Error("JWT is not configured.");
    return value;
  };
  const update = (patch: Partial<Config>): void => initialize({ ...get(), ...patch });
  if (initial) initialize(initial);
  return { initialize, update, get, jwtSecret, snapshot: () => config };
};

export type ConfigStore = ReturnType<typeof createConfigStore>;
export const defaultConfigStore = createConfigStore();
export const initializeConfig = defaultConfigStore.initialize;
export const getConfig = defaultConfigStore.get;
export const updateConfig = defaultConfigStore.update;
