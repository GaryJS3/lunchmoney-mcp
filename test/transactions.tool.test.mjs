import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../build/server.js";
import { initializeConfig } from "../build/config.js";
import {
    sandbox,
    FIXTURES,
    withAttachmentsDir,
    muteStderr,
} from "./helpers.mjs";

/**
 * Integration cover for the `attach_file_to_transaction` boundary itself,
 * driven through a real MCP client over an in-memory transport.
 *
 * The unit tests in attachments.*.test.mjs prove the reader is safe. These
 * prove the *tool* still wires that reader up correctly and still advertises a
 * schema that can't be talked around — the original issue #16 report turned on
 * `content_type` being a free-form string the caller controlled.
 *
 * Nothing here reaches the network: every case is rejected before the upload,
 * which is exactly the property being asserted.
 */
describe("attach_file_to_transaction — tool boundary", () => {
    let client;
    let box;

    before(async () => {
        initializeConfig("TEST-TOKEN-NOT-USED");
        const server = createServer("test");
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        client = new Client({ name: "test", version: "0" });
        await Promise.all([
            client.connect(clientTransport),
            server.connect(serverTransport),
        ]);
    });

    after(async () => {
        await client.close();
    });

    before(() => {
        box = sandbox();
    });

    after(() => {
        box.cleanup();
    });

    const schema = async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "attach_file_to_transaction");
        assert.ok(tool, "attach_file_to_transaction should be registered");
        return tool;
    };

    it("advertises content_type as a closed enum, not a free-form string", async () => {
        // The issue #16 report leaned on content_type being any string the
        // caller liked. Even though the file's bytes are now authoritative,
        // the schema should not re-open that door.
        const { inputSchema } = await schema();
        const contentType = inputSchema.properties.content_type;
        const values =
            contentType.enum ?? contentType.anyOf?.flatMap((s) => s.enum ?? []);
        assert.deepEqual(
            [...values].sort(),
            [
                "application/pdf",
                "image/heic",
                "image/heif",
                "image/jpeg",
                "image/png",
            ],
            "content_type must be restricted to the allowed attachment types",
        );
    });

    it("tells the model the type is verified from file contents", async () => {
        const tool = await schema();
        assert.match(tool.description, /contents/i);
        assert.match(tool.description, /LUNCHMONEY_ATTACHMENTS_DIR/);
    });

    it("refuses a secret file even when the caller declares an allowed type", async () => {
        const restore = muteStderr();
        try {
            const key = box.file("outside/id_rsa", FIXTURES.privateKey);
            const result = await client.callTool({
                name: "attach_file_to_transaction",
                arguments: {
                    transaction_id: 1,
                    file_path: key,
                    content_type: "image/png",
                },
            });
            assert.equal(result.isError, true);
            assert.match(
                result.content[0].text,
                /not a supported attachment type/,
            );
        } finally {
            restore();
        }
    });

    it("refuses a path outside the configured attachments directory", async () => {
        const restore = muteStderr();
        try {
            const outside = box.file("outside/receipt.png", FIXTURES.png);
            const result = await withAttachmentsDir(box.vault, () =>
                client.callTool({
                    name: "attach_file_to_transaction",
                    arguments: { transaction_id: 1, file_path: outside },
                }),
            );
            assert.equal(result.isError, true);
            assert.match(
                result.content[0].text,
                /resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR/,
            );
        } finally {
            restore();
        }
    });

    it("refuses a genuine PNG that the caller mislabels as a PDF", async () => {
        const restore = muteStderr();
        try {
            const png = box.file("vault/receipt.png", FIXTURES.png);
            const result = await client.callTool({
                name: "attach_file_to_transaction",
                arguments: {
                    transaction_id: 1,
                    file_path: png,
                    content_type: "application/pdf",
                },
            });
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /does not match/);
        } finally {
            restore();
        }
    });

    it("rejects a content_type outside the enum at the schema layer", async () => {
        const restore = muteStderr();
        try {
            const png = box.file("vault/schema.png", FIXTURES.png);
            const result = await client
                .callTool({
                    name: "attach_file_to_transaction",
                    arguments: {
                        transaction_id: 1,
                        file_path: png,
                        content_type: "application/x-sh",
                    },
                })
                .catch((error) => ({ isError: true, thrown: error }));
            assert.ok(
                result.isError,
                "an unlisted content_type must not be accepted",
            );
        } finally {
            restore();
        }
    });
});
