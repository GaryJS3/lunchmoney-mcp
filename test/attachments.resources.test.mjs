import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    writeSync,
} from "node:fs";

import { readAttachment, MAX_ATTACHMENT_BYTES } from "../build/attachments.js";
import {
    sandbox,
    FIXTURES,
    withAttachmentsDir,
    muteStderr,
} from "./helpers.mjs";

/**
 * How long a call is allowed to take before the test calls it a hang.
 *
 * Every path exercised here returns in single-digit milliseconds when the
 * hardening is in place, so 5s is pure headroom for a loaded CI box.
 */
const HANG_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol("timed out");

/**
 * Race `promise` against a timer and fail if the timer wins.
 *
 * The tests below feed `readAttachment` paths that used to make it block
 * forever (a FIFO) or read without bound (`/dev/zero`). Awaiting those directly
 * would hang the whole suite — and, in the FIFO case, hang it in a way `node
 * --test` cannot recover from, because the blocked `open(2)` pins a libuv
 * threadpool thread and the process will not exit. Racing turns a regression
 * into a fast, legible assertion failure instead.
 *
 * Confirmed by mutation: dropping `O_NONBLOCK` from the open in
 * `src/attachments.ts` fails both FIFO tests at ~5s each, as intended. The
 * runner then still cannot exit — not even with `--test-force-exit`, since the
 * pinned thread outlives the test. So that particular regression surfaces as
 * "failures reported, then CI hangs to its job timeout" rather than a clean red
 * run. The failures are printed first, which is what matters for diagnosis.
 */
async function withinTimeout(promise, label) {
    let timer;
    const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), HANG_TIMEOUT_MS);
        timer.unref?.();
    });
    try {
        const result = await Promise.race([promise, guard]);
        assert.notEqual(
            result,
            TIMED_OUT,
            `${label}: readAttachment did not return within ${HANG_TIMEOUT_MS}ms — it hung`,
        );
        return result;
    } finally {
        clearTimeout(timer);
    }
}

describe("attachment file-type guards", () => {
    let box;

    beforeEach(() => {
        box = sandbox();
    });

    afterEach(() => {
        box.cleanup();
    });

    it("rejects a FIFO instead of blocking forever waiting for a writer", async () => {
        // The regression this guards: a read-only open(2) on a FIFO blocks
        // until some other process opens the write end. Without
        // O_RDONLY | O_NONBLOCK this call never returns, the request hangs
        // forever, and the pinned libuv threadpool thread stops the server
        // process from exiting at all. The isFile() check is no help on its
        // own — it only runs after the open that never completes.
        const fifo = box.fifo("outside/pipe.png");

        const restore = muteStderr();
        try {
            const result = await withinTimeout(
                withAttachmentsDir(undefined, () => readAttachment(fifo)),
                "FIFO (unconfined)",
            );

            assert.equal(result.ok, false);
            assert.match(result.message, /must point to a regular file/);
        } finally {
            restore();
        }
    });

    it("rejects a FIFO created inside the configured attachments directory, where confinement offers no protection", async () => {
        // Path confinement cannot defend against this: anyone who can drop a
        // file in the attachments directory can drop a FIFO there too, and it
        // passes every containment check before reaching the open.
        const fifo = box.fifo("vault/receipt.png");

        const restore = muteStderr();
        try {
            const result = await withinTimeout(
                withAttachmentsDir(box.vault, () => readAttachment(fifo)),
                "FIFO (inside vault)",
            );

            assert.equal(result.ok, false);
            assert.match(result.message, /must point to a regular file/);
        } finally {
            restore();
        }
    });

    it("rejects the /dev/zero character device without hanging or buffering it", async (t) => {
        // The regression this guards: the 10MB cap used to be applied after
        // readFile() had already buffered the file, so /dev/zero — infinite,
        // and reporting size 0 — grew the heap without bound (~11GB RSS in
        // ten seconds). Rejecting non-regular files off the stat is what stops
        // a single byte of it being read.
        if (!existsSync("/dev/zero")) {
            t.skip("/dev/zero is not present on this platform");
            return;
        }

        const restore = muteStderr();
        try {
            const result = await withinTimeout(
                withAttachmentsDir(undefined, () =>
                    readAttachment("/dev/zero"),
                ),
                "/dev/zero",
            );

            assert.equal(result.ok, false);
            assert.match(result.message, /must point to a regular file/);
        } finally {
            restore();
        }
    });

    it("rejects a directory path with the regular-file message rather than throwing", async () => {
        const dir = box.dir("outside/receipts");

        const restore = muteStderr();
        try {
            const result = await withAttachmentsDir(undefined, () =>
                readAttachment(dir),
            );

            assert.equal(result.ok, false);
            assert.match(result.message, /must point to a regular file/);
        } finally {
            restore();
        }
    });

    it("resolves and reads a symlink that points at a genuine regular file", async () => {
        // The non-regular-file guard must not cost legitimate symlink use:
        // stat() on the handle follows the link, so the target's mode decides.
        const target = box.file("outside/receipt.png", FIXTURES.png);
        const link = box.link("outside/latest.png", target);

        const result = await withAttachmentsDir(undefined, () =>
            readAttachment(link),
        );

        assert.equal(
            result.ok,
            true,
            `expected success, got: ${result.message}`,
        );
        assert.equal(result.mime, "image/png");
        assert.deepEqual(result.data, FIXTURES.png);
    });

    it("rejects an empty file as an unsupported type rather than throwing on a zero-byte header read", async () => {
        const empty = box.file("outside/empty.png", Buffer.alloc(0));

        const restore = muteStderr();
        try {
            const result = await withAttachmentsDir(undefined, () =>
                readAttachment(empty),
            );

            assert.equal(result.ok, false);
            assert.match(result.message, /not a supported attachment type/);
        } finally {
            restore();
        }
    });
});

describe("attachment size cap", () => {
    let box;

    beforeEach(() => {
        box = sandbox();
    });

    afterEach(() => {
        box.cleanup();
    });

    it("rejects a file one byte over the maximum, from stat, before reading any of it", async () => {
        // Sparse, so this costs no disk and no time. The file opens with a
        // genuine PNG signature, which means content sniffing alone would
        // happily accept it — only a size check performed on the stat can
        // produce the rejection asserted below.
        const oversize = box.sparse(
            "outside/huge.png",
            MAX_ATTACHMENT_BYTES + 1,
        );
        const fd = openSync(oversize, "r+");
        try {
            writeSync(fd, FIXTURES.png, 0, FIXTURES.png.length, 0);
        } finally {
            closeSync(fd);
        }

        const restore = muteStderr();
        try {
            const result = await withinTimeout(
                withAttachmentsDir(undefined, () => readAttachment(oversize)),
                "oversized sparse file",
            );

            assert.equal(result.ok, false);
            assert.match(result.message, /file size/);
            assert.match(
                result.message,
                new RegExp(String(MAX_ATTACHMENT_BYTES + 1)),
                "message should report the file's actual size",
            );
            assert.match(
                result.message,
                new RegExp(String(MAX_ATTACHMENT_BYTES)),
                "message should report the maximum",
            );
            // The size check has to run before the content check, so a valid
            // PNG prefix must not change the verdict or the wording.
            assert.doesNotMatch(
                result.message,
                /not a supported attachment type/,
            );
        } finally {
            restore();
        }
    });

    it("accepts a genuine PNG comfortably under the maximum", async () => {
        const png = box.file("outside/small.png", FIXTURES.png);
        assert.ok(
            FIXTURES.png.length < MAX_ATTACHMENT_BYTES,
            "fixture must sit under the cap for this boundary to mean anything",
        );

        const result = await withAttachmentsDir(undefined, () =>
            readAttachment(png),
        );

        assert.equal(
            result.ok,
            true,
            `expected success, got: ${result.message}`,
        );
        assert.equal(result.mime, "image/png");
        assert.deepEqual(result.data, FIXTURES.png);
    });
});

describe("attachment payload integrity", () => {
    let box;

    beforeEach(() => {
        box = sandbox();
    });

    afterEach(() => {
        box.cleanup();
    });

    it("returns every byte of a PDF larger than the 1024-byte header window, unshifted and untruncated", async () => {
        // The implementation reads a 1024-byte header at an explicit position
        // so the handle's own offset stays at 0 and the following readFile()
        // still yields the whole file. Drop the explicit position and this
        // upload silently loses its first 1024 bytes. The filler is a
        // non-repeating byte pattern so any shift or truncation shows up as a
        // mismatch rather than coincidentally comparing equal.
        const filler = Buffer.from(
            Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 251),
        );
        const pdf = Buffer.concat([
            FIXTURES.pdf,
            filler,
            Buffer.from("\n%%EOF\n"),
        ]);
        assert.ok(
            pdf.length > 1024 * 4,
            "fixture must be several header windows long",
        );

        const path = box.file("outside/statement.pdf", pdf);

        const result = await withAttachmentsDir(undefined, () =>
            readAttachment(path),
        );

        assert.equal(
            result.ok,
            true,
            `expected success, got: ${result.message}`,
        );
        assert.equal(result.mime, "application/pdf");
        assert.equal(
            result.data.length,
            pdf.length,
            "returned buffer length must match the file on disk",
        );
        assert.ok(
            result.data.equals(pdf),
            "returned bytes must equal the file's contents exactly",
        );
        assert.ok(
            result.data.equals(readFileSync(path)),
            "returned bytes must equal a plain readFile of the same path",
        );
    });
});
