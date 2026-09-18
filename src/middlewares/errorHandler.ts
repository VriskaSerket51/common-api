import type { ErrorRequestHandler } from "express";
import { HttpException, ResponseException } from "../exceptions/index.js";
import { logger } from "../logger/index.js";

const defaultErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ResponseException) {
    res.status(200).json({ status: error.status, message: error.message });
    return;
  }
  if (error instanceof HttpException) {
    res.sendStatus(error.status);
    return;
  }
  // Preserve client errors from Express parsers without exposing their messages.
  const status = typeof error === "object" && error !== null && "status" in error
    ? error.status : undefined;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
    res.sendStatus(status);
    return;
  }
  logger.error(error);
  res.sendStatus(500);
};

export default defaultErrorHandler;
