import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sniffMimeType, contentTypeMatches } from "../build/attachments.js";
import { FIXTURES, isoBmff } from "./helpers.mjs";

/**
 * Content sniffing is the control that closed the arbitrary-file-read reported
 * in issue #16: the caller's `content_type` is an assertion, the file's leading
 * bytes are the authority. Every test below names the property it protects so a
 * failure reads as "this security guarantee broke", not "a string changed".
 */

describe("sniffMimeType — accepted types are recognised from real bytes", () => {
    it("recognises a real PNG by its 8-byte signature", () => {
        assert.equal(sniffMimeType(FIXTURES.png), "image/png");
    });

    it("recognises a real JPEG by its SOI marker", () => {
        assert.equal(sniffMimeType(FIXTURES.jpeg), "image/jpeg");
    });

    it("recognises a PDF whose header is at offset 0", () => {
        assert.equal(sniffMimeType(FIXTURES.pdf), "application/pdf");
    });

    it("recognises a PDF behind a scanner preamble (header is not anchored at byte 0)", () => {
        assert.equal(
            sniffMimeType(FIXTURES.pdfWithPreamble),
            "application/pdf",
        );
    });

    it("finds %PDF- late in the 1024-byte window, as conforming readers do", () => {
        const padded = Buffer.concat([
            Buffer.alloc(900, 0x20),
            Buffer.from("%PDF-1.7\n%%EOF\n"),
        ]);
        assert.equal(sniffMimeType(padded), "application/pdf");
    });
});

describe("sniffMimeType — ISO-BMFF brand handling", () => {
    for (const brand of ["heic", "heix", "hevc", "hevx"]) {
        it(`maps major brand ${brand} to image/heic`, () => {
            assert.equal(sniffMimeType(isoBmff(brand)), "image/heic");
        });
    }

    for (const brand of ["mif1", "msf1", "heim", "heis", "hevm", "hevs"]) {
        it(`maps major brand ${brand} to image/heif`, () => {
            assert.equal(sniffMimeType(isoBmff(brand)), "image/heif");
        });
    }

    it("classifies an iOS .HEIC (major brand mif1, compatible heic) as image/heif", () => {
        // The major brand wins; compatible brands are deliberately ignored.
        // contentTypeMatches() is what stops this from rejecting a caller who
        // sensibly calls the file image/heic.
        assert.equal(sniffMimeType(isoBmff("mif1", ["heic"])), "image/heif");
    });

    it("ignores compatible brands when the major brand already decides", () => {
        assert.equal(
            sniffMimeType(isoBmff("heic", ["mif1", "miaf", "MiHB"])),
            "image/heic",
        );
    });
});

describe("sniffMimeType — rejects everything outside the allow-list (issue #16)", () => {
    it("returns null for an SSH private key, so key material can never be uploaded", () => {
        assert.equal(sniffMimeType(FIXTURES.privateKey), null);
    });

    it("returns null for a dotenv file, so credentials can never be uploaded", () => {
        assert.equal(sniffMimeType(FIXTURES.dotenv), null);
    });

    it("returns null for /etc/passwd contents, so host account data can never be uploaded", () => {
        assert.equal(sniffMimeType(FIXTURES.passwd), null);
    });

    it("returns null for arbitrary text", () => {
        assert.equal(sniffMimeType(Buffer.from("just some notes\n")), null);
    });

    it("returns null for an empty buffer", () => {
        assert.equal(sniffMimeType(Buffer.alloc(0)), null);
    });

    it("returns null for an ISO-BMFF container whose brand is not HEIC/HEIF (avif)", () => {
        assert.equal(sniffMimeType(isoBmff("avif")), null);
    });

    it("returns null for a QuickTime ISO-BMFF container", () => {
        assert.equal(sniffMimeType(isoBmff("qt  ")), null);
    });

    it("returns null for an MP4 ISO-BMFF container", () => {
        assert.equal(sniffMimeType(isoBmff("isom", ["mp41"])), null);
    });

    it("does not treat a file merely mentioning HEIC brand names as an image", () => {
        assert.equal(sniffMimeType(Buffer.from("heic mif1 hevc\n")), null);
    });
});

describe("sniffMimeType — truncated and partial signatures are not accepted", () => {
    it("returns null for the first 2 bytes of a PNG signature", () => {
        assert.equal(sniffMimeType(FIXTURES.png.subarray(0, 2)), null);
    });

    it("returns null for a 7-byte PNG signature (one byte short)", () => {
        assert.equal(sniffMimeType(FIXTURES.png.subarray(0, 7)), null);
    });

    it("returns null for a partial PDF header (%PD)", () => {
        assert.equal(sniffMimeType(Buffer.from("%PD")), null);
    });

    it("returns null for a 3-byte buffer that is not a JPEG SOI", () => {
        assert.equal(sniffMimeType(Buffer.from([0xff, 0xd8, 0x00])), null);
    });

    it("returns null for a 2-byte JPEG SOI with the third marker byte missing", () => {
        assert.equal(sniffMimeType(Buffer.from([0xff, 0xd8])), null);
    });
});

describe("sniffMimeType — boundary and robustness", () => {
    it("does not throw for every prefix length of every fixture", () => {
        for (const [name, buffer] of Object.entries(FIXTURES)) {
            for (let n = 0; n <= buffer.length; n++) {
                assert.doesNotThrow(
                    () => sniffMimeType(buffer.subarray(0, n)),
                    `sniffMimeType threw on ${name} truncated to ${n} bytes`,
                );
            }
        }
    });

    it("does not throw for every prefix length of an ISO-BMFF header", () => {
        const heic = isoBmff("heic");
        for (let n = 0; n <= heic.length; n++) {
            assert.doesNotThrow(() => sniffMimeType(heic.subarray(0, n)));
        }
    });

    it("accepts a buffer that is exactly the PNG signature length", () => {
        assert.equal(sniffMimeType(FIXTURES.png.subarray(0, 8)), "image/png");
    });

    it("accepts a buffer that is exactly the JPEG signature length", () => {
        assert.equal(
            sniffMimeType(Buffer.from([0xff, 0xd8, 0xff])),
            "image/jpeg",
        );
    });

    it("accepts a buffer that is exactly the PDF marker length", () => {
        assert.equal(sniffMimeType(Buffer.from("%PDF-")), "application/pdf");
    });

    it("accepts a buffer that is exactly the ISO-BMFF brand length (12 bytes)", () => {
        const twelve = isoBmff("heic").subarray(0, 12);
        assert.equal(twelve.length, 12);
        assert.equal(sniffMimeType(twelve), "image/heic");
    });

    it("returns null, not a throw, when ftyp is present but the buffer ends before the brand", () => {
        const truncated = isoBmff("heic").subarray(0, 8);
        assert.equal(truncated.subarray(4, 8).toString("latin1"), "ftyp");
        assert.equal(sniffMimeType(truncated), null);
    });

    it("returns null, not a throw, when the brand itself is cut short", () => {
        const truncated = isoBmff("heic").subarray(0, 11);
        assert.equal(sniffMimeType(truncated), null);
    });
});

describe("contentTypeMatches — the caller's declared type is only ever a cross-check", () => {
    it("matches identical types", () => {
        for (const type of [
            "image/png",
            "image/jpeg",
            "application/pdf",
            "image/heic",
            "image/heif",
        ]) {
            assert.equal(contentTypeMatches(type, type), true);
        }
    });

    it("treats image/heic declared against image/heif bytes as a match", () => {
        assert.equal(contentTypeMatches("image/heic", "image/heif"), true);
    });

    it("treats image/heif declared against image/heic bytes as a match (both directions)", () => {
        assert.equal(contentTypeMatches("image/heif", "image/heic"), true);
    });

    it("does not match image/png against application/pdf", () => {
        assert.equal(contentTypeMatches("image/png", "application/pdf"), false);
        assert.equal(contentTypeMatches("application/pdf", "image/png"), false);
    });

    it("does not match image/jpeg against image/heic", () => {
        assert.equal(contentTypeMatches("image/jpeg", "image/heic"), false);
        assert.equal(contentTypeMatches("image/heic", "image/jpeg"), false);
    });

    it("does not let the HEIF family widen to unrelated types", () => {
        assert.equal(contentTypeMatches("image/heic", "image/png"), false);
        assert.equal(contentTypeMatches("text/plain", "text/plain"), true);
        assert.equal(
            contentTypeMatches("image/heif", "application/pdf"),
            false,
        );
    });
});

describe("declaring an allowed content_type cannot launder a secret file", () => {
    it("leaves a private key unclassified, so no declared type can ever match it", () => {
        const actual = sniffMimeType(FIXTURES.privateKey);
        assert.equal(
            actual,
            null,
            "a private key must never sniff as an allowed attachment type",
        );
        // With no actual type there is nothing to compare against: the read is
        // rejected before contentTypeMatches() is ever consulted. Prove that no
        // allowed declaration would have matched even if it were.
        for (const declared of [
            "image/jpeg",
            "image/png",
            "image/heic",
            "image/heif",
            "application/pdf",
        ]) {
            assert.equal(
                contentTypeMatches(declared, String(actual)),
                false,
                `declaring ${declared} must not make a private key uploadable`,
            );
        }
    });

    it("leaves dotenv and /etc/passwd contents unclassified for the same reason", () => {
        for (const [name, buffer] of Object.entries({
            dotenv: FIXTURES.dotenv,
            passwd: FIXTURES.passwd,
        })) {
            assert.equal(
                sniffMimeType(buffer),
                null,
                `${name} must never sniff as an allowed attachment type`,
            );
        }
    });
});
