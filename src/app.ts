import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { ListenOptions } from "node:net";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import { createRouter, createRouterByFiles, type RouterDefinition } from "./router/index.js";
import {
  createErrorHandler,
  createRouterMiddlewares,
  type PermissionChecker,
  defaultRouterMiddlewares,
  type ErrorMiddleware,
  type Middleware,
  type RouterMiddleware,
} from "./middlewares/index.js";
import { createRuntime, defaultRuntime, type Runtime } from "./runtime.js";
import type { Config } from "./config/index.js";
import { waitForShutdown, validateShutdownOptions, type ShutdownOptions } from "./shutdown.js";
import type { Logger } from "pino";
import { HttpException } from "./exceptions/index.js";

declare global {
  namespace Express {
    interface Locals {
      requestId?: string;
      log?: Logger;
      signal?: AbortSignal;
    }
  }
}

interface AppBaseOptions {
  config?: Config;
  permissionChecker?: PermissionChecker;
  routerDir?: string;
  routers?: readonly RouterDefinition[];
  middlewares?: readonly Middleware[];
  routerMiddleware?: RouterMiddleware;
  errorHandlers?: readonly ErrorMiddleware[];
  cors?: CorsOptions | false;
}

export type AppOptions<TDatabase = undefined> = AppBaseOptions & (
  [TDatabase] extends [undefined] ? { runtime?: Runtime<TDatabase> } : { runtime: Runtime<TDatabase> }
);

export class App<TDatabase = undefined> {
  readonly expressApp: express.Application;
  readonly runtime: Runtime<TDatabase>;
  private abortController = new AbortController();
  private sockets = new Set<Socket>();
  private server: Server | undefined;
  private starting: Promise<Server> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(options: AppBaseOptions, runtime: Runtime<TDatabase>) {
    this.runtime = runtime;
    this.expressApp = express();
    this.expressApp.use((_req, res, next) => {
      const requestId = randomUUID();
      const disconnected = new AbortController();
      res.locals.requestId = requestId;
      res.locals.log = this.runtime.logger.child({ requestId });
      res.locals.signal = AbortSignal.any([this.abortController.signal, disconnected.signal]);
      res.setHeader("X-Request-Id", requestId);
      res.once("close", () => { if (!res.writableFinished) disconnected.abort(); });
      next();
    });
    this.initMiddlewares(options.middlewares ?? [], options.cors);
  }

  static create<TDatabase>(options: AppOptions<TDatabase>): Promise<App<TDatabase>>;
  static create(options?: AppOptions): Promise<App>;
  /** @deprecated Pass an AppOptions object instead. */
  static create(
    routerDir: string,
    middlewares: Middleware[],
    routerMiddleware: RouterMiddleware,
    errorHandlers: ErrorMiddleware[],
  ): Promise<App>;
  static async create(
    optionsOrDirectory: (AppBaseOptions & { runtime?: Runtime<unknown> }) | string = {},
    middlewares: Middleware[] = [],
    routerMiddleware: RouterMiddleware = defaultRouterMiddlewares,
    errorHandlers: ErrorMiddleware[] = [],
  ): Promise<App<unknown>> {
    const options = typeof optionsOrDirectory === "string"
      ? { routerDir: optionsOrDirectory, middlewares, routerMiddleware, errorHandlers, runtime: defaultRuntime }
      : optionsOrDirectory;
    if (options.runtime && options.config) throw new Error("Pass runtime or config, not both.");
    const config = options.config ?? defaultRuntime.config.snapshot();
    const runtime = options.runtime ?? createRuntime(config === undefined ? {} : { config });
    const app = new App(options, runtime);
    const routeMiddleware = options.routerMiddleware ?? createRouterMiddlewares(options.permissionChecker, app.runtime.jwt);
    app.expressApp.use(createRouter(options.routers ?? [], routeMiddleware));
    if (options.routerDir) await app.initRouters(options.routerDir, routeMiddleware);
    app.initErrorHandlers(options.errorHandlers ?? []);
    return app;
  }

  async listen(options: number | ListenOptions): Promise<Server> {
    if (this.server || this.starting || this.closing) {
      throw new Error("The application is already starting, listening, or closing.");
    }
    this.abortController = new AbortController();
    this.starting = new Promise<Server>((resolve, reject) => {
      const server = this.expressApp.listen(
        typeof options === "number" ? { port: options } : options,
        (error?: Error) => {
          if (error) {
            if (this.server === server) this.server = undefined;
            reject(error);
          } else {
            resolve(server);
          }
        },
      );
      this.server = server;
      server.on("connection", socket => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
      });
      server.once("close", () => {
        if (this.server === server) this.server = undefined;
      });
    });
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  close(options: ShutdownOptions = {}): Promise<void> {
    validateShutdownOptions(options);
    if (!this.closing) {
      this.closing = (async () => {
        if (this.starting) {
          try { await this.starting; } catch { return; }
        }
        const server = this.server;
        if (!server) return;
        await new Promise<void>((resolve, reject) => {
          server.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          });
        });
      })().finally(() => { this.closing = undefined; });
    }
    return waitForShutdown(this.closing, options, reason => {
      this.abortController.abort(reason);
      this.server?.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
    });
  }

  /** Stops producers before closing this runtime's database; defaults to a 30s total budget. */
  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    validateShutdownOptions(options);
    const started = Date.now();
    const remaining = () => ({ ...options, timeoutMs: Math.max(0, (options.timeoutMs ?? 30_000) - (Date.now() - started)) });
    const results = await Promise.allSettled([
      this.close(remaining()), this.runtime.scheduler.shutdown(remaining()),
    ]);
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Shutdown did not finish; database remains open for active work.");
    await this.runtime.closeDatabase(remaining());
  }

  /** @deprecated Use await app.listen(port) instead. */
  run(port: number, onSuccessed: () => void, onFailed: (error: Error) => void): void {
    void this.listen(port).then(onSuccessed, onFailed);
  }

  initMiddlewares(middlewares: readonly Middleware[], corsOptions?: CorsOptions | false) {
    this.expressApp.use(helmet());
    if (corsOptions !== false) this.expressApp.use(cors(corsOptions));
    this.expressApp.use(express.json());
    this.expressApp.use(express.urlencoded({ extended: true }));
    if (middlewares.length) this.expressApp.use(...middlewares);
  }

  async initRouters(routerDir: string, routerMiddleware: RouterMiddleware) {
    this.expressApp.use(await createRouterByFiles(routerDir, routerMiddleware));
  }

  initErrorHandlers(errorHandlers: readonly ErrorMiddleware[]) {
    this.expressApp.use((_req, _res, next) => next(new HttpException(404)));
    if (errorHandlers.length) this.expressApp.use(...errorHandlers);
    this.expressApp.use(createErrorHandler(this.runtime.logger));
  }
}

export default App;
export type { ShutdownOptions } from "./shutdown.js";
