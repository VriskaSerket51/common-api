import type { Runtime } from "../runtime/index.js";

/** App-scoped dependencies available while constructing routes. */
export type RouteServices<TDatabase = undefined> = Pick<Runtime<TDatabase>,
  "database" | "jwt" | "logger" | "scheduler" | "config">;

export function routeServices<TDatabase>(runtime: RouteServices<TDatabase>): RouteServices<TDatabase> {
  const { database, jwt, logger, scheduler, config } = runtime;
  return Object.freeze({ database, jwt, logger, scheduler, config });
}
