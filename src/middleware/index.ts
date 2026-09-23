import type { RequestHandler, ErrorRequestHandler, Request, Response } from "express";
import { HttpException } from "#app/errors/index";
import type { ModelBase } from "#app/router/index";
import {
  defaultJwt, type JwtService,
} from "#app/jwt/index";

export type RouterMiddleware = (model: ModelBase) => readonly Middleware[];

export type Middleware = RequestHandler;
export type ErrorMiddleware = ErrorRequestHandler;

export { default as defaultErrorHandler, createErrorHandler } from "#app/middleware/error-handler";

export type PermissionChecker = (permission: number, req: Request, res: Response) => boolean | Promise<boolean>;

export const createRouterMiddlewares = (checkPermission?: PermissionChecker, auth: JwtService = defaultJwt): RouterMiddleware => (model) => {
  const { verifyAccessTokenMiddleware, verifyRefreshTokenMiddleware } = auth;
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
        return verifyAccessTokenMiddleware(req, res, next, false);
      });
      break;
    default:
      break;
  }
  return middlewares;
};

export const defaultRouterMiddlewares = createRouterMiddlewares();
