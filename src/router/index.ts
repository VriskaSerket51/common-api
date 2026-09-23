import { Router, type RequestHandler } from "express";
import { pathToFileURL } from "node:url";
import { defaultRouterMiddlewares, type RouterMiddleware, type Middleware } from "#app/middleware/index";
import { readAllFilesAsync } from "#app/utils/files";
import { defaultRuntime, type Runtime } from "#app/runtime/index";
import { routeServices, type RouteServices } from "#app/router/services";
export type { RouteServices } from "#app/router/services";
export { collectEndpointContracts, createEndpointRoutes } from "#app/router/endpoints";
export type { EndpointContract, Endpoint } from "#app/router/endpoints";
export { loadEndpoints } from "#app/router/endpoint-discovery";
export type { EndpointDiscoveryOptions } from "#app/router/endpoint-discovery";

export type RoutesFactory<TDatabase = undefined> =
  (services: RouteServices<TDatabase>) => readonly RouterDefinition[] | Promise<readonly RouterDefinition[]>;

const routesFactory = Symbol("common-api.routesFactory");

/** Marks a default export for file discovery without executing unrelated functions. */
export function defineRoutes<TDatabase = undefined>(factory: RoutesFactory<TDatabase>): RoutesFactory<TDatabase> {
  return Object.assign(factory, { [routesFactory]: true });
}

export interface RouterDefinition {
  path: string;
  models: readonly ModelBase[];
}

export const createRouter = (
  definitions: readonly RouterDefinition[],
  modelMiddleware: RouterMiddleware = defaultRouterMiddlewares,
): Router => {
  const root = Router();
  for (const definition of definitions) {
    const router = Router();
    for (const model of definition.models) {
      router[model.method](
        model.path,
        ...modelMiddleware(model),
        ...(model.middlewares ?? []),
        model.controller,
      );
    }
    root.use(definition.path, router);
  }
  return root;
};

export const createRouterByFiles = async (
  dirName: string,
  modelMiddleware: RouterMiddleware = defaultRouterMiddlewares,
  runtime: Runtime<unknown> = defaultRuntime,
): Promise<Router> => {
  const definitions: RouterDefinition[] = [];

  if (!dirName) {
    return createRouter(definitions, modelMiddleware);
  }

  const fileNames = await readAllFilesAsync(
    dirName,
    (fileName) =>
      /\.(?:ts|mts|js|mjs)$/.test(fileName) &&
      !/\.d\.(?:ts|mts)$/.test(fileName)
  );

  for (const fileName of fileNames) {
    const module = (await import(pathToFileURL(fileName).href)).default;
    if (typeof module === "function" && module[routesFactory] === true) {
      definitions.push(...await module(routeServices(runtime)));
      continue;
    }
    if (!module || !(module.prototype instanceof RouterBase)) {
      continue;
    }
    definitions.push(new module());
  }

  return createRouter(definitions, modelMiddleware);
};

export interface ModelBase {
  method: "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
  path: string;
  authType?: "access" | "refresh" | "optional";
  /** Requires a PermissionChecker supplied through createRouterMiddlewares(). */
  permission?: number;
  middlewares?: readonly Middleware[];
  controller: RequestHandler;
}

export type RouteDefinition = ModelBase;

export class RouterBase implements RouterDefinition {
  path: string = "";
  models: ModelBase[] = [];

  setPath(path: string) {
    this.path += path;
  }
}
