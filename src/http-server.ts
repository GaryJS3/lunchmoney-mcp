import {
    createServer as createHttpServer,
    type IncomingMessage,
    type ServerResponse,
} from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

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

export const createLunchMoneyHttpServer = (version: string) =>
    createHttpServer(async (request, response) => {
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

        const server = createServer(version);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        try {
            await server.connect(transport);
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
            } else if (!response.writableEnded) {
                response.destroy();
            }
        } finally {
            await server.close();
        }
    });
