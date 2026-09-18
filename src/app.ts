import express from "express";
import type { Server } from "node:http";
import type { ListenOptions } from "node:net";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import { createRouter, createRouterByFiles, type RouterDefinition } from "./router/index.js";
import {
  defaultErrorHandler,
  defaultRouterMiddlewares,
  type ErrorMiddleware,
  type Middleware,
  type RouterMiddleware,
} from "./middlewares/index.js";
import { HttpException } from "./exceptions/index.js";

export interface AppOptions {
  routerDir?: string;
  routers?: readonly RouterDefinition[];
  middlewares?: readonly Middleware[];
  routerMiddleware?: RouterMiddleware;
  errorHandlers?: readonly ErrorMiddleware[];
  cors?: CorsOptions | false;
}

export default class App {
  readonly expressApp: express.Application;
  private server?: Server;
  private starting?: Promise<Server>;
  private closing?: Promise<void>;

  private constructor(options: AppOptions) {
    this.expressApp = express();
    this.initMiddlewares(options.middlewares ?? [], options.cors);
  }

  static create(options?: AppOptions): Promise<App>;
  /** @deprecated Pass an AppOptions object instead. */
  static create(
    routerDir: string,
    middlewares: Middleware[],
    routerMiddleware: RouterMiddleware,
    errorHandlers: ErrorMiddleware[],
  ): Promise<App>;
  static async create(
    optionsOrDirectory: AppOptions | string = {},
    middlewares: Middleware[] = [],
    routerMiddleware: RouterMiddleware = defaultRouterMiddlewares,
    errorHandlers: ErrorMiddleware[] = [],
  ): Promise<App> {
    const options: AppOptions = typeof optionsOrDirectory === "string"
      ? { routerDir: optionsOrDirectory, middlewares, routerMiddleware, errorHandlers }
      : optionsOrDirectory;
    const app = new App(options);
    const routeMiddleware = options.routerMiddleware ?? defaultRouterMiddlewares;
    app.expressApp.use(createRouter(options.routers ?? [], routeMiddleware));
    if (options.routerDir) await app.initRouters(options.routerDir, routeMiddleware);
    app.initErrorHandlers(options.errorHandlers ?? []);
    return app;
  }

  async listen(options: number | ListenOptions): Promise<Server> {
    if (this.server || this.starting || this.closing) {
      throw new Error("The application is already starting, listening, or closing.");
    }
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

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.starting) {
        try { await this.starting; } catch { return; }
      }
      const server = this.server;
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
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
    this.expressApp.use(defaultErrorHandler);
  }
}
