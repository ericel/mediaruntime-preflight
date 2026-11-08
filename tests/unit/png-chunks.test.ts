import { describe, expect, it } from "vitest";

import { createFileReader } from "../../src/core/reader";
import type { FormatCheckContext } from "../../src/formats/contracts";
import {
    iteratePngChunks,
    readPngChunk,
    type PngChunk,
} from "../../src/formats/png/chunks";

const SIGNATURE = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Build a framing fixture, without computing its CRC. */
function makeChunk(
    type: string,
    dataLength = 0,
): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(dataLength + 12);

    new DataView(bytes.buffer).setUint32(0, dataLength, false);

    for (let index = 0; index < 4; index += 1) {
        bytes[4 + index] = type.charCodeAt(index);
    }

    return bytes;
}

/** Construct a source and a shared inspection context. */
function makeContext(
    chunks: Uint8Array<ArrayBuffer>[],
    maxBytesRead = 1024,
): FormatCheckContext {
    const source = new Blob([SIGNATURE, ...chunks]);

    return {
        reader: createFileReader(source, {
            maxBytesRead,
            maxReadSizeBytes: 8,
        }),
        prefix: SIGNATURE,
        checkpoint() {
            // Most tests do not impose a time limit.
        },
    };
}

/** Collect descriptors only for these small test fixtures. */
async function collect(
    context: FormatCheckContext,
): Promise<PngChunk[]> {
    const chunks: PngChunk[] = [];

    for await (const chunk of iteratePngChunks(context)) {
        chunks.push(chunk);
    }

    return chunks;
}

describe("PNG chunk traversal", () => {
    it("calculates offsets and reads only eight bytes per chunk", async () => {
        const context = makeContext([
            makeChunk("IHDR", 13),
            makeChunk("IDAT", 100),
            makeChunk("IEND"),
        ]);

        const chunks = await collect(context);

        expect(chunks.map((chunk) => chunk.type)).toEqual([
            "IHDR",
            "IDAT",
            "IEND",
        ]);

        expect(chunks[0]).toEqual({
            type: "IHDR",
            offsetBytes: 8,
            dataOffsetBytes: 16,
            dataLengthBytes: 13,
            crcOffsetBytes: 29,
            endOffsetBytes: 33,
        });

        expect(chunks[1]?.offsetBytes).toBe(33);
        expect(chunks[2]?.offsetBytes).toBe(145);

        // Signature bytes were supplied as already detected.
        expect(context.reader.bytesRead).toBe(24);
    });

    it("skips a large payload under a small read budget", async () => {
        const context = makeContext([
            makeChunk("IDAT", 1024 * 1024),
            makeChunk("IEND"),
        ], 16);

        const chunks = await collect(context);

        expect(chunks).toHaveLength(2);
        expect(context.reader.bytesRead).toBe(16);
    });

    it("rejects an incomplete envelope without reading it", async () => {
        const context = makeContext([new Uint8Array(11)]);

        await expect(collect(context)).rejects.toMatchObject({
            code: "PNG_CHUNK_TRUNCATED",
            offsetBytes: 8,
        });

        expect(context.reader.bytesRead).toBe(0);
    });

    it("rejects a payload extending beyond the file", async () => {
        const chunk = makeChunk("IDAT");

        // Declare more data than exists in the fixture.
        new DataView(chunk.buffer).setUint32(0, 100, false);

        const context = makeContext([chunk]);

        await expect(collect(context)).rejects.toMatchObject({
            code: "PNG_CHUNK_TRUNCATED",
        });

        expect(context.reader.bytesRead).toBe(8);
    });

    it("rejects a length above the PNG maximum", async () => {
        const chunk = makeChunk("IDAT");
        new DataView(chunk.buffer).setUint32(0, 0x80000000, false);

        await expect(
            collect(makeContext([chunk])),
        ).rejects.toMatchObject({
            code: "PNG_CHUNK_LENGTH_INVALID",
        });
    });

    it("rejects non-letter chunk type bytes", async () => {
        await expect(
            collect(makeContext([makeChunk("ID1T")])),
        ).rejects.toMatchObject({
            code: "PNG_CHUNK_TYPE_INVALID",
            offsetBytes: 14,
        });
    });

    it("requires IEND when fully traversed", async () => {
        await expect(
            collect(makeContext([makeChunk("IHDR", 13)])),
        ).rejects.toMatchObject({
            code: "PNG_IEND_MISSING",
            offsetBytes: 33,
        });
    });

    it("rejects a nonempty IEND", async () => {
        await expect(
            collect(makeContext([makeChunk("IEND", 1)])),
        ).rejects.toMatchObject({
            code: "PNG_IEND_LENGTH_INVALID",
        });
    });

    it("stops at IEND and exposes its end offset", async () => {
        const context = makeContext([
            makeChunk("IEND"),
            new Uint8Array([1, 2, 3]),
        ]);

        const chunks = await collect(context);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.endOffsetBytes).toBe(20);
        expect(context.reader.sizeBytes).toBe(23);
        expect(context.reader.bytesRead).toBe(8);
    });

    it("propagates read budget exhaustion", async () => {
        const context = makeContext([
            makeChunk("IHDR", 13),
            makeChunk("IEND"),
        ], 8);

        await expect(collect(context)).rejects.toMatchObject({
            code: "READ_BUDGET_EXCEEDED",
        });
    });

    it("propagates a checkpoint error before reading", async () => {
        const baseContext = makeContext([makeChunk("IEND")]);
        const deadlineError = new Error("Deadline exhausted.");

        const context: FormatCheckContext = {
            ...baseContext,
            checkpoint() {
                throw deadlineError;
            },
        };

        await expect(collect(context)).rejects.toBe(deadlineError);
        expect(context.reader.bytesRead).toBe(0);
    });

    it("observes cancellation between yielded chunks", async () => {
        const controller = new AbortController();
        const context = makeContext([
            makeChunk("IHDR", 13),
            makeChunk("IEND"),
        ]);

        // Override through a new context; the contract fields are readonly.
        const cancellableContext: FormatCheckContext = {
            ...context,
            signal: controller.signal,
            checkpoint() {
                if (controller.signal.aborted) {
                    throw new DOMException("Cancelled.", "AbortError");
                }
            },
        };

        const iterator = iteratePngChunks(cancellableContext);

        await iterator.next();
        controller.abort();

        await expect(iterator.next()).rejects.toMatchObject({
            name: "AbortError",
        });

        expect(context.reader.bytesRead).toBe(8);
    });

    it("rejects invalid caller offsets as programming errors", async () => {
        const context = makeContext([makeChunk("IEND")]);

        await expect(
            readPngChunk(context, -1),
        ).rejects.toBeInstanceOf(RangeError);

        expect(context.reader.bytesRead).toBe(0);
    });
});