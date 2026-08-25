#!/usr/bin/env node
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type ServerResponse,
} from "http";
import { createRequire } from "module";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initializeConfig } from "./config.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const port = 3000;
const host = "0.0.0.0";

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
        return undefined;
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const sendError = (
    response: ServerResponse,
    statusCode: number,
    message: string,
) => {
    response.writeHead(statusCode, {
        "content-type": "text/plain; charset=utf-8",
    });
    response.end(message);
};

const main = async () => {
    const token = process.env.LUNCHMONEY_API_TOKEN;
    if (!token) {
        throw new Error(
            "LUNCHMONEY_API_TOKEN is required to start the HTTP server.",
        );
    }

    initializeConfig(token);
    const server = createServer(version);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);

    const httpServer = createHttpServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://localhost")
            .pathname;

        if (pathname === "/health") {
            if (request.method !== "GET") {
                sendError(response, 405, "Method Not Allowed");
                return;
            }
            response.writeHead(200, {
                "content-type": "text/plain; charset=utf-8",
            });
            response.end("ok\n");
            return;
        }

        if (pathname !== "/mcp") {
            sendError(response, 404, "Not Found");
            return;
        }

        try {
            const body =
                request.method === "POST"
                    ? await readRequestBody(request)
                    : undefined;
            await transport.handleRequest(request, response, body);
        } catch (error) {
            if (!response.headersSent) {
                sendError(
                    response,
                    400,
                    error instanceof Error ? error.message : "Invalid request",
                );
            } else {
                response.destroy();
            }
        }
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(
            `Received ${signal}; shutting down LunchMoney MCP HTTP server...`,
        );
        await transport.close();
        await server.close();
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
