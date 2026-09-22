import { SignJWT, jwtVerify, errors, type JWTPayload, type JWTVerifyOptions } from "jose";
import type { Response, Request, NextFunction } from "express";
import { defaultConfigStore } from "../config/index.js";
import { HttpException, ResponseException } from "../exceptions/index.js";
import { randomUUID } from "node:crypto";

export interface AuthPayload extends JWTPayload {
  type: "access" | "refresh";
}

export interface JwtSignOptions {
  algorithm?: "HS256";
  /** Seconds, or an explicit duration such as "10m", "6h", "7d". */
  expiresIn?: number | string;
  notBefore?: number | string;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  jwtid?: string;
  noTimestamp?: boolean;
}
export type JwtVerifyOptions = Omit<JWTVerifyOptions, "algorithms" | "crit">;

const durationSeconds = (value: number | string): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = /^(-?\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(value.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
      const unit = units[match[2].toLowerCase()];
      const seconds = unit === undefined ? NaN : Number(match[1]) * unit;
      if (Number.isFinite(seconds)) return seconds;
    }
  }
  throw new TypeError("JWT duration must be seconds or a number followed by s, m, h, d, or w.");
};

const signingOptions = new Set([
  "algorithm", "expiresIn", "notBefore", "issuer", "audience", "subject", "jwtid", "noTimestamp",
]);

declare global {
  namespace Express {
    interface Locals {
      auth?: AuthPayload;
    }
  }
}

export const createJwt = (resolveSecret: () => string) => {
  const key = () => new TextEncoder().encode(resolveSecret());
  const createToken = async (
    type: AuthPayload["type"], payload: object, options: JwtSignOptions = {},
  ): Promise<string> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("JWT payload must be an object.");
    }
    for (const name of Object.keys(options)) {
      if (!signingOptions.has(name)) throw new TypeError("Unsupported JWT signing option: " + name);
    }
    if (options.algorithm !== undefined && options.algorithm !== "HS256") {
      throw new TypeError("This JWT service only supports HS256.");
    }
    const claims: JWTPayload = { ...payload, type };
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = claims.iat ?? now;
    if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) throw new TypeError("iat must be a finite number.");
    if (options.noTimestamp) delete claims.iat;
    else claims.iat = issuedAt;
    for (const [claim, option] of [["exp", "expiresIn"], ["nbf", "notBefore"], ["iss", "issuer"],
      ["aud", "audience"], ["sub", "subject"], ["jti", "jwtid"]] as const) {
      if (claims[claim] !== undefined && options[option] !== undefined) {
        throw new TypeError("Specify " + claim + " in either payload or options, not both.");
      }
    }
    claims.jti ??= options.jwtid ?? randomUUID();
    if (claims.exp === undefined) claims.exp = Math.floor(issuedAt + durationSeconds(options.expiresIn ?? (type === "access" ? "10m" : "6h")));
    if (options.notBefore !== undefined) claims.nbf = Math.floor(issuedAt + durationSeconds(options.notBefore));
    if (options.issuer !== undefined) claims.iss = options.issuer;
    if (options.audience !== undefined) claims.aud = options.audience;
    if (options.subject !== undefined) claims.sub = options.subject;
    for (const name of ["exp", "nbf"] as const) {
      if (claims[name] !== undefined && (typeof claims[name] !== "number" || !Number.isFinite(claims[name]))) {
        throw new TypeError(name + " must be a finite number.");
      }
    }
    return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(key());
  };

  const createAccessToken = (payload: object, options?: JwtSignOptions): Promise<string> =>
    createToken("access", payload, options);
  const createRefreshToken = (payload: object, options?: JwtSignOptions): Promise<string> =>
    createToken("refresh", payload, options);

  const verifyJwt = async (token: string, options: JwtVerifyOptions = {}): Promise<JWTPayload> => {
    const { payload } = await jwtVerify(token, key(), { ...options, algorithms: ["HS256"] });
    return payload;
  };

  const verifyToken = async (
    type: AuthPayload["type"], req: Request, res: Response, next: NextFunction, required = true,
  ): Promise<void> => {
    delete res.locals.auth;
    const bearer = req.headers.authorization;
    if (!bearer) {
      if (required) next(new HttpException(401));
      else next();
      return;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(bearer);
    if (!match?.[1]) { next(new HttpException(401)); return; }
    let decoded: JWTPayload;
    try {
      decoded = await verifyJwt(match[1]);
    } catch (error) {
      if (error instanceof errors.JWTExpired) next(new ResponseException(-100, "토큰이 만료됐습니다."));
      else if (error instanceof errors.JOSEError) next(new ResponseException(-101, "토큰이 유효하지 않습니다."));
      else next(error);
      return;
    }
    if (decoded.type !== type) { next(new ResponseException(-101, "토큰이 유효하지 않습니다.")); return; }
    res.locals.auth = decoded as AuthPayload;
    next();
  };

  const verifyAccessTokenMiddleware = (
    req: Request, res: Response, next: NextFunction, isRequired = true,
  ): Promise<void> => verifyToken("access", req, res, next, isRequired);
  const verifyRefreshTokenMiddleware = (
    req: Request, res: Response, next: NextFunction,
  ): Promise<void> => verifyToken("refresh", req, res, next);

  return { createAccessToken, createRefreshToken, verifyJwt, verifyAccessTokenMiddleware, verifyRefreshTokenMiddleware };
};
export type JwtService = ReturnType<typeof createJwt>;
export const defaultJwt = createJwt(defaultConfigStore.jwtSecret);
export const { createAccessToken, createRefreshToken, verifyJwt, verifyAccessTokenMiddleware, verifyRefreshTokenMiddleware } = defaultJwt;
