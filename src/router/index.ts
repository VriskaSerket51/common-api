import { Router, type RequestHandler } from "express";
import { pathToFileURL } from "node:url";
import { defaultRouterMiddlewares, type RouterMiddleware, type Middleware } from "../middleware/index.js";
import { readAllFilesAsync } from "../utils/files.js";

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
  modelMiddleware: RouterMiddleware = defaultRouterMiddlewares
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
