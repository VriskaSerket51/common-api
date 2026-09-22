import { STATUS_CODES } from "node:http";

export class Exception extends Error {
  public message: string;

  constructor(message: string = "", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.message = message;
  }
}

export interface HttpExceptionOptions extends ErrorOptions {
  /** Application-owned public error code, independent of HTTP status. */
  code?: string | number;
  message?: string;
  /** Defaults to true for 4xx, false for 5xx. Never exposes cause or stack. */
  expose?: boolean;
}

/** Extend this class for application-specific errors, or use a custom error middleware. */
export class HttpException extends Exception {
  readonly status: number;
  readonly code: string | number;
  readonly expose: boolean;

  constructor(status: number, options: HttpExceptionOptions = {}) {
    super(options.message ?? STATUS_CODES[status] ?? "Request failed", options);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError("HttpException status must be an integer between 400 and 599.");
    }
    this.status = status;
    this.code = options.code ?? `HTTP_${status}`;
    this.expose = options.expose ?? status < 500;
  }
}

/** @deprecated Legacy HTTP 200 envelope. Use HttpException with a public code instead. */
export class ResponseException extends Exception {
  public status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}
