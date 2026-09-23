import type { Request, Response, NextFunction } from "express";
import type { ModelBase, RouterDefinition } from "#app/router/index";

export interface EndpointContract<TMetadata = unknown> {
  operationId: string;
  method: ModelBase["method"];
  /** Absolute path, using OpenAPI-style parameters such as /users/{id}. */
  path: string;
  authType?: ModelBase["authType"];
  permission?: number;
  middlewares?: ModelBase["middlewares"];
  /** Application-owned schemas or documentation; never interpreted by common-api. */
  metadata?: TMetadata;
}

/** Declare the route and its implementation together; no controller factory is required. */
export type Endpoint<TContext = void, TMetadata = unknown> = EndpointContract<TMetadata> & {
  handle(req: Request, res: Response, context: TContext, next: NextFunction): unknown;
};

/** Return document metadata without executing request handlers. */
export function collectEndpointContracts<TContext, TMetadata>(
  endpoints: readonly Endpoint<TContext, TMetadata>[],
): readonly EndpointContract<TMetadata>[] {
  const contracts = endpoints.map(({ handle, ...contract }) => {
    if (typeof handle !== "function") throw new Error(`Missing handler: ${contract.operationId}`);
    return contract;
  });
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const contract of contracts) {
    const { operationId, method, path, authType, permission } = contract;
    if (!operationId.trim()) throw new Error("Empty operation ID");
    if (ids.has(operationId)) throw new Error(`Duplicate operation ID: ${operationId}`);
    ids.add(operationId);
    if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }
    if (path !== "/" && !/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z_][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z_][A-Za-z0-9_]*\}))*\/?$/.test(path)) {
      throw new Error(`Unsupported endpoint path: ${path}`);
    }
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    if (new Set(params).size !== params.length) throw new Error(`Duplicate path parameter: ${path}`);
    const key = `${method} ${path.replace(/\{[^}]+\}/g, "{}").replace(/\/$/, "").toLowerCase()}`;
    if (routes.has(key)) throw new Error(`Duplicate endpoint route: ${method} ${path}`);
    routes.add(key);
    if (authType !== undefined && !["access", "refresh", "optional"].includes(authType)) {
      throw new Error(`Unsupported authentication: ${operationId}`);
    }
    if (permission !== undefined && (authType !== "access" || !Number.isFinite(permission))) {
      throw new Error(`Permission requires access authentication and a finite value: ${operationId}`);
    }
  }
  return contracts;
}

export function createEndpointRoutes<TContext, TMetadata>(
  endpoints: readonly Endpoint<TContext, TMetadata>[],
  context: TContext,
): RouterDefinition[] {
  collectEndpointContracts(endpoints);
  const models: ModelBase[] = endpoints.map(({ method, path, authType, permission, middlewares, handle }) => ({
    method, path: path.replace(/\{([^}]+)\}/g, ":$1"),
    controller: (req, res, next) => handle(req, res, context, next),
    ...(authType === undefined ? {} : { authType }),
    ...(permission === undefined ? {} : { permission }),
    ...(middlewares === undefined ? {} : { middlewares }),
  }));
  return [{ path: "/", models }];
}
