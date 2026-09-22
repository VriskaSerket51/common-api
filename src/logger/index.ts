import { pino, type DestinationStream, type LevelWithSilent, type Logger } from "pino";
export type { Logger } from "pino";

export interface LoggerOptions {
  level?: LevelWithSilent;
  silent?: boolean;
  /** Caller-owned output stream; defaults to stdout. */
  destination?: DestinationStream;
}

export const serializeError = (error: unknown, seen = new WeakSet<object>()): unknown => {
  if (!(error instanceof Error)) return String(error);
  if (seen.has(error)) return "[Circular error]";
  seen.add(error);
  try {
    return {
      name: error.name, message: error.message, stack: error.stack,
      ...(error.cause !== undefined ? { cause: serializeError(error.cause, seen) } : {}),
      ...(error instanceof AggregateError ? { errors: error.errors.map(item => serializeError(item, seen)) } : {}),
      ...("code" in error ? { code: error.code } : {}),
    };
  } finally {
    seen.delete(error);
  }
};

/** Outputs Pino JSON records. The caller owns and closes custom destinations. */
export const createLogger = (options: LoggerOptions = {}): Logger => {
  const settings = {
    level: options.silent ? "silent" : (options.level ?? "info"),
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: serializeError, error: serializeError },
  };
  return options.destination ? pino(settings, options.destination) : pino(settings);
};

export const logger = createLogger();
