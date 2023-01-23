import { Router } from "express";
import { RouterMiddleware } from "../middlewares";
import { readAllFiles } from "../utils";
import { RouterBase } from "./RouterBase";

export const createRouterByFiles = (
    dirName: string,
    modelMiddleware: RouterMiddleware
): Router => {
    const defaultRouter = Router();

    if (!dirName) {
        return defaultRouter;
    }

    const fileNames: string[] = [];
    readAllFiles(dirName, fileNames, (fileName) =>
        fileName.startsWith("index")
    );

    fileNames.forEach((fileName) => {
        const module = require(fileName).default;
        if (!module || !(module.prototype instanceof RouterBase)) {
            return;
        }
        const subrouter: RouterBase = new module();

        const router = Router();
        subrouter.models.forEach((model) => {
            router[model.method](
                model.path,
                ...modelMiddleware(model),
                model.controller
            );
        });
        defaultRouter.use(subrouter.path, router);
    });

    return defaultRouter;
};
