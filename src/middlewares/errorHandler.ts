import type { ErrorRequestHandler } from "express";
import { STATUS_CODES } from "node:http";
import { HttpException, ResponseException } from "../exceptions/index.js";
import { logger } from "../logger/index.js";

export const createErrorHandler = (log = logger): ErrorRequestHandler => (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  // Compatibility only: applications can override this using errorHandlers.
  if (error instanceof ResponseException) {
    res.status(200).json({ status: error.status, message: error.message });
    return;
  }
  const candidate = typeof error === "object" && error !== null && "status" in error
    ? error.status : undefined;
  const isHttp = error instanceof HttpException;
  // Preserve client errors from Express parsers without exposing their messages.
  const status = isHttp ? error.status
    : typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate < 500
      ? candidate : 500;
  const code = isHttp ? error.code : `HTTP_${status}`;
  const message = isHttp && error.expose ? error.message : STATUS_CODES[status] ?? "Request failed";
  if (status >= 500) {
    log.error({ error, status, code, requestId: res.locals.requestId, method: req.method, path: req.path }, "Request failed");
  }
  res.status(status).json({ error: { code, message }, requestId: res.locals.requestId });
};

export default createErrorHandler();
