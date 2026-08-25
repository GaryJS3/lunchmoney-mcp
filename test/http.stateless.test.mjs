import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { initializeConfig } from "../build/config.js";
import { createLunchMoneyHttpServer } from "../build/http-server.js";

let httpServer;
let endpoint;

before(async () => {
    initializeConfig("TEST-TOKEN-NOT-USED");
    httpServer = createLunchMoneyHttpServer("test");
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
});

after(async () => {
    await new Promise((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
    );
});

const initialize = () =>
    fetch(endpoint, {
        method: "POST",
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "stateless-test", version: "1.0.0" },
            },
        }),
    });

const call = (method) =>
    fetch(endpoint, {
        method: "POST",
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    });

test("independent clients can initialize without sharing a session", async () => {
    const first = await initialize();
    const second = await initialize();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.has("mcp-session-id"), false);
    assert.equal(second.headers.has("mcp-session-id"), false);
    assert.equal((await first.json()).result.serverInfo.name, "lunchmoney-mcp");
    assert.equal(
        (await second.json()).result.serverInfo.name,
        "lunchmoney-mcp",
    );
});

test("unsupported discovery reaches MCP method handling", async () => {
    const response = await call("server/discover");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
    });
});
