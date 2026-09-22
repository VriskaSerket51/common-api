import winston from "winston";
import winstonDaily from "winston-daily-rotate-file";

export interface LoggerOptions {
  level?: string;
  logDir?: string;
  console?: boolean;
  silent?: boolean;
  transports?: winston.LoggerOptions["transports"];
}

export const serializeError = (error: unknown, seen = new WeakSet<object>()): unknown => {
  if (!(error instanceof Error)) return String(error);
  if (seen.has(error)) return "[Circular error]";
  seen.add(error);
  return {
    name: error.name, message: error.message, stack: error.stack,
    ...(error.cause !== undefined ? { cause: serializeError(error.cause, seen) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(item => serializeError(item, seen)) } : {}),
    ...("code" in error ? { code: error.code } : {}),
  };
};

export const createLogger = (options: LoggerOptions = {}): winston.Logger => {
  const transports: winston.transport[] = [];
  if (options.console !== false) transports.push(new winston.transports.Console());
  if (options.logDir) {
    transports.push(new winstonDaily({
      dirname: options.logDir, filename: "%DATE%.log", datePattern: "YYYY-MM-DD",
      maxFiles: "30d", zippedArchive: true,
    }));
  }
  return winston.createLogger({
    level: options.level ?? "info", silent: options.silent,
    format: winston.format.combine(
      winston.format((info) => {
        if (info instanceof Error) info.error = serializeError(info);
        else if (info.error !== undefined) info.error = serializeError(info.error);
        if (info.message instanceof Error) {
          info.error = serializeError(info.message);
          info.message = info.message.message;
        }
        return info;
      })(),
      winston.format.timestamp(), winston.format.json(),
    ),
    transports: options.transports ?? transports,
  });
};

export const logger = createLogger();
