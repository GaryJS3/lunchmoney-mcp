import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

const { O_RDONLY, O_NONBLOCK } = constants;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
    "application/pdf",
] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// The image signatures all sit in the first 12 bytes, but the PDF spec allows
// junk before `%PDF-` and conforming readers scan the first 1024 bytes for it,
// so the window has to be wide enough to match what real scanners emit.
const ATTACHMENT_HEADER_BYTES = 1024;
const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// ISO-BMFF major brands. HEIC and HEIF share a container; the brand decides
// which of the two MIME types the LunchMoney API expects. Plenty of real
// `.HEIC` files (iOS among them) carry `mif1` as the major brand and list
// `heic` only as a compatible brand, so the two are treated as interchangeable
// when checking a caller's `content_type` assertion.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heim", "heis", "hevm", "hevs"]);
const HEIF_FAMILY = new Set<string>(["image/heic", "image/heif"]);

/**
 * Whether a caller's `content_type` assertion is compatible with the type the
 * file's own bytes reported.
 *
 * HEIC and HEIF are interchangeable here: the ISO-BMFF major brand does not
 * reliably distinguish them, so a caller calling an `mif1` file `image/heic`
 * is right rather than confused. Both are accepted types regardless.
 */
export function contentTypeMatches(declared: string, actual: string): boolean {
    if (declared === actual) return true;
    return HEIF_FAMILY.has(declared) && HEIF_FAMILY.has(actual);
}

/**
 * Identify an attachment by its leading bytes.
 *
 * The file extension and any caller-supplied MIME type are both untrusted —
 * only the contents decide. Returns `null` for anything that is not one of the
 * types the LunchMoney attachments endpoint accepts, which is what stops the
 * attach tool from being used to read arbitrary non-media files off the host.
 */
export function sniffMimeType(header: Buffer): string | null {
    if (
        header.length >= 3 &&
        header[0] === 0xff &&
        header[1] === 0xd8 &&
        header[2] === 0xff
    ) {
        return "image/jpeg";
    }
    if (header.length >= 8 && header.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return "image/png";
    }
    // Not anchored at offset 0: the PDF spec tolerates bytes before the header
    // and conforming readers scan for it, as do the scanners that produce some
    // receipts. Files of the kind this check exists to exclude — keys,
    // credentials, `/etc/passwd` — do not contain this marker, so the wider
    // window is free.
    if (header.includes("%PDF-", 0, "latin1")) {
        return "application/pdf";
    }
    if (
        header.length >= 12 &&
        header.subarray(4, 8).toString("latin1") === "ftyp"
    ) {
        const brand = header.subarray(8, 12).toString("latin1");
        if (HEIC_BRANDS.has(brand)) return "image/heic";
        if (HEIF_BRANDS.has(brand)) return "image/heif";
    }
    return null;
}

export type AttachmentRead =
    | { ok: true; data: Buffer; mime: string }
    | { ok: false; message: string };

/**
 * The configured attachments directory, or `undefined` when unconfined.
 *
 * Claude Desktop only substitutes a `${user_config.X}` template when the user
 * actually fills the field in; an optional field left blank arrives as the
 * literal template string. That is truthy, so without this guard every
 * `.mcpb` install that skipped the directory prompt would fail to resolve it
 * and the tool would be unusable. An unsubstituted template means "unset".
 */
export function attachmentsRoot(): string | undefined {
    const root = process.env.LUNCHMONEY_ATTACHMENTS_DIR?.trim();
    if (!root || root.includes("${user_config.")) return undefined;
    return root;
}

/**
 * Read a file the caller named, for upload as a transaction attachment.
 *
 * `file_path` reaches this server from an AI model, which may in turn be acting
 * on untrusted content (a payee name, a note, a web page). Treat it as hostile:
 *
 * 1. If `LUNCHMONEY_ATTACHMENTS_DIR` is set, the path must resolve inside it.
 *    The check runs after `realpath`, so `..` traversal and symlink escapes are
 *    both caught. Unset means unconfined — fine for a desktop stdio server,
 *    where the caller and the file owner are the same person, but deployments
 *    that expose this server over HTTP should always set it.
 * 2. Only regular files, so `/dev/*` and directories are rejected. The open is
 *    non-blocking because a read-only `open(2)` on a FIFO blocks until a writer
 *    appears — without `O_NONBLOCK` a caller could hang the request forever,
 *    pin a libuv threadpool thread, and stop the server exiting cleanly.
 * 3. Size is checked from `stat` before any bytes are buffered, so a huge file
 *    can't exhaust memory on its way to being rejected.
 * 4. The type comes from the leading bytes, checked before the rest of the file
 *    is read. Credentials, keys, and dotenv files never make it into memory.
 *
 * Filesystem errors are logged to stderr but reported back to the caller
 * generically — distinguishing ENOENT from EACCES would let a caller map out
 * the host's filesystem one failed call at a time.
 */
export async function readAttachment(
    filePath: string,
): Promise<AttachmentRead> {
    const unreadable = {
        ok: false as const,
        message: "file could not be read.",
    };
    const root = attachmentsRoot();

    let resolved: string;
    try {
        resolved = await realpath(resolve(filePath));
    } catch (error) {
        console.error(`Failed to resolve attachment path: ${describe(error)}`);
        return unreadable;
    }

    if (root) {
        let base: string;
        try {
            base = await realpath(resolve(root));
        } catch (error) {
            console.error(
                `Failed to resolve LUNCHMONEY_ATTACHMENTS_DIR: ${describe(error)}`,
            );
            return {
                ok: false,
                message: `the directory configured in LUNCHMONEY_ATTACHMENTS_DIR (${root}) could not be resolved.`,
            };
        }
        if (resolved !== base && !resolved.startsWith(base + sep)) {
            return {
                ok: false,
                message:
                    "file_path resolves outside the directory configured in LUNCHMONEY_ATTACHMENTS_DIR.",
            };
        }
    }

    let handle;
    try {
        handle = await open(resolved, O_RDONLY | O_NONBLOCK);
    } catch (error) {
        console.error(`Failed to open attachment: ${describe(error)}`);
        return unreadable;
    }

    try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
            return {
                ok: false,
                message: "file_path must point to a regular file.",
            };
        }
        if (stats.size > MAX_ATTACHMENT_BYTES) {
            return {
                ok: false,
                message: `file size ${stats.size} bytes exceeds maximum of ${MAX_ATTACHMENT_BYTES} bytes (10MB).`,
            };
        }

        // Reading at an explicit position leaves the handle's own offset at 0,
        // so the readFile() below still returns the whole file.
        const header = Buffer.alloc(ATTACHMENT_HEADER_BYTES);
        const { bytesRead } = await handle.read(
            header,
            0,
            ATTACHMENT_HEADER_BYTES,
            0,
        );
        const mime = sniffMimeType(header.subarray(0, bytesRead));
        if (!mime) {
            return {
                ok: false,
                message: `the file's contents are not a supported attachment type. Allowed types are: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(", ")}`,
            };
        }

        return { ok: true, data: await handle.readFile(), mime };
    } catch (error) {
        console.error(`Failed to read attachment: ${describe(error)}`);
        return unreadable;
    } finally {
        await handle.close().catch(() => {});
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
