#!/usr/bin/env node
import { createRequire } from "module";
import { initializeConfig } from "./config.js";
import { createLunchMoneyHttpServer } from "./http-server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const port = 3000;
const host = "0.0.0.0";

const main = async () => {
    const token = process.env.LUNCHMONEY_API_TOKEN;
    if (!token) {
        throw new Error(
            "LUNCHMONEY_API_TOKEN is required to start the HTTP server.",
        );
    }

    initializeConfig(token);
    const httpServer = createLunchMoneyHttpServer(version);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(
            `Received ${signal}; shutting down LunchMoney MCP HTTP server...`,
        );
        await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => (error ? reject(error) : resolve()));
        });
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => resolve());
    });
    console.error(
        `LunchMoney MCP HTTP server listening on http://${host}:${port}/mcp`,
    );
};

main().catch((error) => {
    console.error("Fatal error in HTTP server:", error);
    process.exitCode = 1;
});
