import { execFileSync } from "node:child_process";
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    mkdirSync,
    symlinkSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal but genuine file contents for each type the attachments endpoint
 * accepts, plus the kinds of files the sniffing check exists to keep out.
 */
export const FIXTURES = {
    // Real 1x1 PNG.
    png: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
    ),
    // JPEG SOI + APP0/JFIF.
    jpeg: Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        Buffer.from("JFIF\0"),
        Buffer.alloc(16),
    ]),
    pdf: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n"),
    // A PDF from a scanner that emits a preamble before the header.
    pdfWithPreamble: Buffer.concat([
        Buffer.from("\r\n#!scanner preamble, not part of the PDF\r\n"),
        Buffer.from("%PDF-1.7\ntrailer\n%%EOF\n"),
    ]),
    privateKey: Buffer.from(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
    ),
    dotenv: Buffer.from(
        "AWS_SECRET_ACCESS_KEY=AKIA-PLANTED-9999\nDB_PASS=hunter2\n",
    ),
    passwd: Buffer.from(
        "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin\n",
    ),
};

/**
 * Build an ISO-BMFF header with the given major brand, as HEIC/HEIF files use.
 * `compatible` brands follow the major brand and are deliberately ignored by
 * the sniffer — real `.HEIC` files often put `heic` there and `mif1` in front.
 */
export function isoBmff(majorBrand, compatible = []) {
    const body = Buffer.concat([
        Buffer.from("ftyp"),
        Buffer.from(majorBrand, "latin1"),
        Buffer.from([0, 0, 0, 0]), // minor version
        ...compatible.map((b) => Buffer.from(b, "latin1")),
    ]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length + 4);
    return Buffer.concat([size, body, Buffer.alloc(64)]);
}

/**
 * A throwaway directory tree for one test.
 *
 * `root` holds a `vault/` (the directory a test points
 * LUNCHMONEY_ATTACHMENTS_DIR at) and an `outside/` sibling to escape into.
 * Paths are realpath'd up front so assertions are not confused by macOS
 * symlinking /var to /private/var.
 */
export function sandbox() {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "lm-attach-")));
    const vault = join(real, "vault");
    const outside = join(real, "outside");
    mkdirSync(vault);
    mkdirSync(outside);

    return {
        root: real,
        vault,
        outside,
        /** Write `contents` to `rel` (relative to the sandbox root); returns the path. */
        file(rel, contents) {
            const p = join(real, rel);
            writeFileSync(p, contents);
            return p;
        },
        /** Create a directory at `rel`; returns the path. */
        dir(rel) {
            const p = join(real, rel);
            mkdirSync(p, { recursive: true });
            return p;
        },
        /** Create a symlink at `rel` pointing to `target`; returns the link path. */
        link(rel, target) {
            const p = join(real, rel);
            symlinkSync(target, p);
            return p;
        },
        /** Create a FIFO at `rel`; returns the path. */
        fifo(rel) {
            const p = join(real, rel);
            execFileSync("mkfifo", [p]);
            return p;
        },
        /** Create a sparse file of `bytes` length without allocating it; returns the path. */
        sparse(rel, bytes) {
            const p = join(real, rel);
            execFileSync(
                "dd",
                ["if=/dev/zero", `of=${p}`, "bs=1", "count=0", `seek=${bytes}`],
                { stdio: "ignore" },
            );
            return p;
        },
        cleanup() {
            rmSync(real, { recursive: true, force: true });
        },
    };
}

/**
 * Run `fn` with LUNCHMONEY_ATTACHMENTS_DIR set to `value` (or unset when
 * `value` is undefined), restoring the previous value afterwards.
 */
export async function withAttachmentsDir(value, fn) {
    const key = "LUNCHMONEY_ATTACHMENTS_DIR";
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    }
}

/** Swallow the stderr `console.error` calls the module makes on failure paths. */
export function muteStderr() {
    const original = console.error;
    console.error = () => {};
    return () => {
        console.error = original;
    };
}
