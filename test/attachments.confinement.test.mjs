import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { readAttachment, attachmentsRoot } from "../build/attachments.js";
import {
    sandbox,
    FIXTURES,
    withAttachmentsDir,
    muteStderr,
} from "./helpers.mjs";

describe("attachment path confinement", () => {
    let box;

    beforeEach(() => {
        box = sandbox();
    });

    afterEach(() => {
        box.cleanup();
    });

    describe("unconfined mode (LUNCHMONEY_ATTACHMENTS_DIR unset)", () => {
        it("reads a genuine PNG from anywhere on disk and returns its exact bytes", async () => {
            const png = box.file("outside/anywhere.png", FIXTURES.png);

            const result = await withAttachmentsDir(undefined, () =>
                readAttachment(png),
            );

            assert.equal(result.ok, true);
            assert.equal(result.mime, "image/png");
            assert.deepEqual(result.data, FIXTURES.png);
        });
    });

    describe("confined mode (LUNCHMONEY_ATTACHMENTS_DIR set)", () => {
        it("reads a genuine PNG that lives directly inside the vault", async () => {
            const png = box.file("vault/receipt.png", FIXTURES.png);

            const result = await withAttachmentsDir(box.vault, () =>
                readAttachment(png),
            );

            assert.equal(result.ok, true);
            assert.equal(result.mime, "image/png");
            assert.deepEqual(result.data, FIXTURES.png);
        });

        it("reads a genuine PNG from a nested subdirectory of the vault", async () => {
            box.dir("vault/2026/january");
            const png = box.file(
                join("vault", "2026", "january", "receipt.png"),
                FIXTURES.png,
            );

            const result = await withAttachmentsDir(box.vault, () =>
                readAttachment(png),
            );

            assert.equal(result.ok, true);
            assert.equal(result.mime, "image/png");
            assert.deepEqual(result.data, FIXTURES.png);
        });

        it("rejects an absolute path to a file outside the vault", async () => {
            const secret = box.file("outside/secret.png", FIXTURES.png);

            const result = await withAttachmentsDir(box.vault, () =>
                readAttachment(secret),
            );

            assert.equal(result.ok, false);
            assert.match(
                result.message,
                /resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR/,
            );
        });

        it("rejects `..` traversal that climbs out of the vault", async () => {
            box.file("outside/secret.png", FIXTURES.png);
            const traversal = join(box.vault, "..", "outside", "secret.png");

            const result = await withAttachmentsDir(box.vault, () =>
                readAttachment(traversal),
            );

            assert.equal(result.ok, false);
            assert.match(
                result.message,
                /resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR/,
            );
        });

        it("rejects a symlink inside the vault whose target is outside it, even though the target is a genuine PNG", async () => {
            // The target really is a valid attachment, so a rejection here can
            // only come from post-realpath containment, not content sniffing.
            const target = box.file("outside/secret.png", FIXTURES.png);
            const link = box.link("vault/innocent.png", target);

            const result = await withAttachmentsDir(box.vault, () =>
                readAttachment(link),
            );

            assert.equal(result.ok, false);
            assert.match(
                result.message,
                /resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR/,
            );
        });

        it("rejects a prefix-sibling directory such as `<vault>-evil` that a naive startsWith(base) would allow", async () => {
            box.dir("vault-evil");
            const sneaky = box.file("vault-evil/secret.png", FIXTURES.png);
            assert.ok(
                sneaky.startsWith(box.vault),
                "fixture must share a string prefix with the vault path",
            );

            const result = await withAttachmentsDir(box.vault, () =>
                readAttachment(sneaky),
            );

            assert.equal(result.ok, false);
            assert.match(
                result.message,
                /resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR/,
            );
        });

        it("fails with a message naming LUNCHMONEY_ATTACHMENTS_DIR when the configured directory does not exist", async () => {
            const png = box.file("vault/receipt.png", FIXTURES.png);
            const missing = join(box.root, "no-such-vault");

            const restore = muteStderr();
            try {
                const result = await withAttachmentsDir(missing, () =>
                    readAttachment(png),
                );

                assert.equal(result.ok, false);
                assert.match(result.message, /LUNCHMONEY_ATTACHMENTS_DIR/);
                assert.match(result.message, /could not be resolved/);
            } finally {
                restore();
            }
        });
    });

    describe("filesystem error disclosure", () => {
        it("reports a nonexistent path generically and leaks no errno detail that could be used to enumerate the filesystem", async () => {
            const missing = join(box.root, "does-not-exist.png");

            const restore = muteStderr();
            try {
                const result = await withAttachmentsDir(undefined, () =>
                    readAttachment(missing),
                );

                assert.equal(result.ok, false);
                assert.equal(result.message, "file could not be read.");
                assert.doesNotMatch(
                    result.message,
                    /ENOENT|EACCES|no such file/i,
                );
            } finally {
                restore();
            }
        });
    });
});

describe("attachmentsRoot()", () => {
    it("returns undefined when LUNCHMONEY_ATTACHMENTS_DIR is unset", async () => {
        await withAttachmentsDir(undefined, () => {
            assert.equal(attachmentsRoot(), undefined);
        });
    });

    it("treats an empty string as unset", async () => {
        await withAttachmentsDir("", () => {
            assert.equal(attachmentsRoot(), undefined);
        });
    });

    it("treats a whitespace-only value as unset", async () => {
        await withAttachmentsDir("   \t  ", () => {
            assert.equal(attachmentsRoot(), undefined);
        });
    });

    it("treats an unsubstituted MCPB user_config template as unset", async () => {
        await withAttachmentsDir(
            "${user_config.LUNCHMONEY_ATTACHMENTS_DIR}",
            () => {
                assert.equal(attachmentsRoot(), undefined);
            },
        );
    });

    it("returns a normal path unchanged", async () => {
        await withAttachmentsDir("/srv/receipts", () => {
            assert.equal(attachmentsRoot(), "/srv/receipts");
        });
    });

    it("trims surrounding whitespace from a configured path", async () => {
        await withAttachmentsDir("  /srv/receipts \n", () => {
            assert.equal(attachmentsRoot(), "/srv/receipts");
        });
    });
});

describe("unsubstituted MCPB template behaves as unconfined", () => {
    let box;

    beforeEach(() => {
        box = sandbox();
    });

    afterEach(() => {
        box.cleanup();
    });

    it("reads a genuine PNG outside any vault instead of failing to resolve the template as a directory", async () => {
        const png = box.file("outside/receipt.png", FIXTURES.png);

        const restore = muteStderr();
        try {
            const result = await withAttachmentsDir(
                "${user_config.LUNCHMONEY_ATTACHMENTS_DIR}",
                () => readAttachment(png),
            );

            assert.equal(
                result.ok,
                true,
                `expected success, got: ${result.message}`,
            );
            assert.equal(result.mime, "image/png");
            assert.deepEqual(result.data, FIXTURES.png);
        } finally {
            restore();
        }
    });
});
