import jwt from "jsonwebtoken";
import { Response, Request, NextFunction } from "express";
import config from "../config";
import { HttpException, ResponseException } from "../exceptions";
import { v4 as uuid } from "uuid";
import { logger } from "../utils/Logger";

export const createAccessToken = (payload: any) => {
    payload.type = "access";
    return jwt.sign(payload, config.jwtSecret, {
        algorithm: "HS256",
        expiresIn: "10m",
        jwtid: uuid(),
    });
};

export const verifyJwt = (
    token: string,
    callback: jwt.VerifyCallback<string | jwt.JwtPayload>
) => {
    jwt.verify(token, config.jwtSecret, callback);
};

export const verifyAccessTokenMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
    isRequired: boolean = true
) => {
    const bearer = req.headers.authorization;
    if (!bearer || !bearer.startsWith("Bearer ")) {
        if (isRequired) {
            throw new HttpException(401);
        } else {
            next();
            return;
        }
    }
    const jwtToken = bearer.split("Bearer ")[1];
    verifyJwt(jwtToken, (error, decoded) => {
        if (error?.message === "jwt expired") {
            throw new ResponseException(-1972, "토큰이 만료됐습니다.");
        } else if (
            error?.message === "invalid token" ||
            (decoded as any).type !== "access"
        ) {
            throw new ResponseException(-1973, "토큰이 유효하지 않습니다.");
        } else if (error) {
            logger.error(error);
            throw new HttpException(500);
        } else {
            next();
        }
    });
};

export const createRefreshoken = (payload: any) => {
    payload.type = "refresh";
    return jwt.sign(payload, config.jwtSecret, {
        algorithm: "HS256",
        expiresIn: "6h",
        jwtid: uuid(),
    });
};

export const verifyRefreshTokenMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const bearer = req.headers.authorization;
    if (!bearer || !bearer.startsWith("Bearer ")) {
        throw new HttpException(401);
    }
    const jwtToken = bearer.split("Bearer ")[1];
    verifyJwt(jwtToken, (error, decoded) => {
        if (error?.message === "jwt expired") {
            throw new ResponseException(-1972, "토큰이 만료됐습니다.");
        } else if (
            error?.message === "invalid token" ||
            (decoded as any).type !== "refresh"
        ) {
            throw new ResponseException(-1973, "토큰이 유효하지 않습니다.");
        } else if (error) {
            logger.error(error);
            throw new HttpException(500);
        } else {
            next();
        }
    });
};
