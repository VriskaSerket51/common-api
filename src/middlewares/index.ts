import type { RequestHandler, ErrorRequestHandler, Request, Response } from "express";
import { HttpException } from "../exceptions/index.js";
import type { ModelBase } from "../router/index.js";
import {
  verifyAccessTokenMiddleware,
  verifyRefreshTokenMiddleware,
} from "./jwt.js";

export type RouterMiddleware = (model: ModelBase) => readonly Middleware[];

export type Middleware = RequestHandler;
export type ErrorMiddleware = ErrorRequestHandler;

export { default as defaultErrorHandler } from "./errorHandler.js";
export * from "./jwt.js";

export type PermissionChecker = (permission: number, req: Request, res: Response) => boolean | Promise<boolean>;

export const createRouterMiddlewares = (checkPermission?: PermissionChecker): RouterMiddleware => (model) => {
  const { authType } = model;
  const middlewares: Middleware[] = [];
  if (model.permission !== undefined) {
    if (!checkPermission) throw new Error("Routes with permission require a PermissionChecker.");
    if (!Number.isFinite(model.permission) || (authType !== undefined && authType !== "access")) {
      throw new Error("Permission-protected routes require access authentication and a finite permission value.");
    }
    middlewares.push(verifyAccessTokenMiddleware);
    middlewares.push(async (req, res, next) => {
      if (await checkPermission(model.permission!, req, res)) next();
      else next(new HttpException(403));
    });
    return middlewares;
  }
  switch (authType) {
    case "access":
      middlewares.push(verifyAccessTokenMiddleware);
      break;
    case "refresh":
      middlewares.push(verifyRefreshTokenMiddleware);
      break;
    case "optional":
      middlewares.push((req, res, next) => {
        verifyAccessTokenMiddleware(req, res, next, false);
      });
      break;
    default:
      break;
  }
  return middlewares;
};

export const defaultRouterMiddlewares = createRouterMiddlewares();
