# common-api-ts

Simple backend framework with jwt and mysql support.

## Installation into an existing project

To install `common-api-ts` as a dependency of your Node.js project:

```sh
npm install common-api-ts
```

`common-api-ts` is made by TypeScript, so you don't need to download DefinitelyTyped package.

## How to use

```javascript
import {
    App,
    Config,
    ModelBase,
    Schedule,
    initializeConfig,
    initializeScheduler,
    logger,
} from "common-api-ts";
import path from "path";

initializeConfig(config);
initializeScheduler(schedules);

runExpressApp();

function runExpressApp() {
    const app = new App(
        path.join(__dirname, "router"),
        [],
        routerMiddleware,
        []
    );
    app.run(
        config.port,
        () => {
            console.info(`Server started with port: ${config.port}`);
        },
        (error) => {
            logger.error(error);
        }
    );
}
```

```javascript
const config: Config = {
    jwtSecret: "secret",
    db: {
        host: "127.0.0.1",
        port: 3306,
        user: "root",
        password: "password",
        database: "db",
    },
};
```

```javascript
const schedules: Schedule[] = [
    name: "testSchedule",
    cron: "00 00 00 * * *",
    job: () => {
        console.log("Welcome!")
    },
];
```
