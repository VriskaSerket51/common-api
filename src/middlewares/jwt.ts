import jwt from "jsonwebtoken";
import type { Response, Request, NextFunction } from "express";
import { defaultConfigStore } from "../config/index.js";
import { HttpException, ResponseException } from "../exceptions/index.js";
import { v4 as uuid } from "uuid";

export interface AuthPayload extends jwt.JwtPayload {
  type: "access" | "refresh";
}

declare global {
  namespace Express {
    interface Locals {
      auth?: AuthPayload;
    }
  }
}

export const createJwt = (resolveSecret: () => string) => {
  const createToken = (type: AuthPayload["type"], payload: object, options: jwt.SignOptions = {}) =>
    jwt.sign({ ...payload, type }, resolveSecret(), {
      ...options,
      algorithm: options.algorithm ?? "HS256",
      expiresIn: options.expiresIn ?? (type === "access" ? "10m" : "6h"),
      jwtid: options.jwtid ?? uuid(),
    });

  const createAccessToken = (payload: object, options?: jwt.SignOptions) =>
    createToken("access", payload, options);

  const createRefreshToken = (payload: object, options?: jwt.SignOptions) =>
    createToken("refresh", payload, options);

  const verifyJwt = (token: string, callback: jwt.VerifyCallback<string | jwt.JwtPayload>) => {
    jwt.verify(token, resolveSecret(), callback);
  };

  const verifyToken = (
    type: AuthPayload["type"], req: Request, res: Response, next: NextFunction, required = true,
  ): void => {
    delete res.locals.auth;
    const bearer = req.headers.authorization;
    if (!bearer) {
      if (required) next(new HttpException(401));
      else next();
      return;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(bearer);
    if (!match) {
      next(new HttpException(401));
      return;
    }
    verifyJwt(match[1], (error, decoded) => {
      if (error instanceof jwt.TokenExpiredError) {
        next(new ResponseException(-100, "토큰이 만료됐습니다."));
      } else if (error || !decoded || typeof decoded === "string" || decoded.type !== type) {
        next(new ResponseException(-101, "토큰이 유효하지 않습니다."));
      } else {
        res.locals.auth = decoded as AuthPayload;
        next();
      }
    });
  };

  const verifyAccessTokenMiddleware = (
    req: Request, res: Response, next: NextFunction, isRequired = true,
  ): void => verifyToken("access", req, res, next, isRequired);

  const verifyRefreshTokenMiddleware = (
    req: Request, res: Response, next: NextFunction,
  ): void => verifyToken("refresh", req, res, next);

  return { createAccessToken, createRefreshToken, verifyJwt, verifyAccessTokenMiddleware, verifyRefreshTokenMiddleware };
};

export type JwtService = ReturnType<typeof createJwt>;
export const defaultJwt = createJwt(defaultConfigStore.jwtSecret);
export const { createAccessToken, createRefreshToken, verifyJwt, verifyAccessTokenMiddleware, verifyRefreshTokenMiddleware } = defaultJwt;
