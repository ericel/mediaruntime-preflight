import { describe, expect, it } from "vitest";

import { createFileReader } from "../../src/core/reader";
import { detectFormat } from "../../src/core/detect";
import { inspectPngHeader } from "../../src/formats/png/header";

/**
 * Build a structurally valid PNG header.
 *
 * This is intentionally NOT a complete PNG:
 * - CRC is a placeholder.
 * - IDAT and IEND chunks are absent.
 *
 * Our current inspector checks header fields only.
 */
function makeHeader(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);

  // PNG signature at file offsets 0–7.
  bytes.set([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  // IHDR contains 13 bytes of data.
  view.setUint32(8, 13, false);

  // ASCII "IHDR".
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);

  // Image dimensions: 640 × 480.
  view.setUint32(16, 640, false);
  view.setUint32(20, 480, false);

  bytes[24] = 8; // Bit depth.
  bytes[25] = 6; // RGBA color type.
  bytes[26] = 0; // Compression method.
  bytes[27] = 0; // Filter method.
  bytes[28] = 0; // No interlacing.

  // Bytes 29–32 remain zero: CRC is not checked in this milestone.
  return bytes;
}

/** Run detection first, respecting the inspector's precondition. */
async function inspectHeader(
  bytes: Uint8Array<ArrayBuffer>,
  maxBytesRead = 33,
) {
  const reader = createFileReader(new Blob([bytes]), {
    maxBytesRead,
  });

  const detection = await detectFormat(reader);

  if (detection.detected.format !== "png") {
    throw new Error("Test fixture must contain a PNG signature.");
  }

  const result = await inspectPngHeader(reader);

  return { reader, result };
}

describe("PNG header inspection", () => {
  it("extracts dimensions and reads exactly 33 bytes", async () => {
    const { reader, result } = await inspectHeader(makeHeader());

    expect(result.check.id).toBe("png.header");
    expect(result.check.status).toBe("passed");
    expect(result.metadata).toEqual({
      width: 640,
      height: 480,
    });
    expect(result.findings).toEqual([]);

    expect(reader.bytesRead).toBe(33);
    expect(reader.remainingBudgetBytes).toBe(0);
    expect(reader.activeReads).toBe(0);
  });

  it("does not read additional trailing content", async () => {
    // A 1 MiB fixture is sufficient to verify bounded reads.
    const bytes = new Uint8Array(1024 * 1024);
    bytes.set(makeHeader());

    const { reader, result } = await inspectHeader(bytes);

    expect(result.check.status).toBe("passed");
    expect(reader.sizeBytes).toBe(1024 * 1024);
    expect(reader.bytesRead).toBe(33);
  });

  it("reports truncation without attempting another read", async () => {
    // Keep the full signature but remove the last header byte.
    const bytes = makeHeader().slice(0, 32);

    const { reader, result } = await inspectHeader(bytes);

    expect(result.check.status).toBe("failed");
    expect(result.metadata).toEqual({});
    expect(result.findings[0]).toMatchObject({
      code: "PNG_HEADER_TRUNCATED",
      offsetBytes: 32,
    });

    // Only detection read bytes; the size check caught truncation.
    expect(reader.bytesRead).toBe(8);
  });

  const invalidFields = [
    {
      name: "incorrect first chunk type",
      offset: 12,
      value: 0x49444154, // ASCII "IDAT".
      wide: true,
      code: "PNG_IHDR_MISSING",
    },
    {
      name: "incorrect IHDR data length",
      offset: 8,
      value: 12,
      wide: true,
      code: "PNG_IHDR_LENGTH_INVALID",
    },
    {
      name: "zero width",
      offset: 16,
      value: 0,
      wide: true,
      code: "PNG_WIDTH_INVALID",
    },
    {
      name: "width above the PNG maximum",
      offset: 16,
      value: 0x80000000,
      wide: true,
      code: "PNG_WIDTH_INVALID",
    },
    {
      name: "zero height",
      offset: 20,
      value: 0,
      wide: true,
      code: "PNG_HEIGHT_INVALID",
    },
    {
      name: "height above the PNG maximum",
      offset: 20,
      value: 0x80000000,
      wide: true,
      code: "PNG_HEIGHT_INVALID",
    },
    {
      name: "invalid color type",
      offset: 25,
      value: 1,
      wide: false,
      code: "PNG_COLOR_TYPE_INVALID",
    },
    {
      name: "invalid bit depth for RGBA",
      offset: 24,
      value: 4,
      wide: false,
      code: "PNG_BIT_DEPTH_INVALID",
    },
    {
      name: "invalid compression method",
      offset: 26,
      value: 1,
      wide: false,
      code: "PNG_COMPRESSION_INVALID",
    },
    {
      name: "invalid filter method",
      offset: 27,
      value: 1,
      wide: false,
      code: "PNG_FILTER_INVALID",
    },
    {
      name: "invalid interlace method",
      offset: 28,
      value: 2,
      wide: false,
      code: "PNG_INTERLACE_INVALID",
    },
  ];

  it.each(invalidFields)("rejects $name", async (testCase) => {
    const bytes = makeHeader();
    const view = new DataView(bytes.buffer);

    // Change one field while preserving the rest of the valid header.
    if (testCase.wide) {
      view.setUint32(testCase.offset, testCase.value, false);
    } else {
      view.setUint8(testCase.offset, testCase.value);
    }

    const { result } = await inspectHeader(bytes);

    expect(result.check.status).toBe("failed");
    expect(result.metadata).toEqual({});
    expect(result.findings[0]).toMatchObject({
      code: testCase.code,
      offsetBytes: testCase.offset,
    });
  });

  it.each([
    { colorType: 0, bitDepth: 1 },  // Grayscale.
    { colorType: 0, bitDepth: 16 },
    { colorType: 2, bitDepth: 8 },  // RGB.
    { colorType: 3, bitDepth: 4 },  // Indexed color.
    { colorType: 4, bitDepth: 16 }, // Grayscale with alpha.
    { colorType: 6, bitDepth: 16 }, // RGBA.
  ])(
    "accepts color type $colorType with bit depth $bitDepth",
    async ({ colorType, bitDepth }) => {
      const bytes = makeHeader();
      bytes[24] = bitDepth;
      bytes[25] = colorType;

      const { result } = await inspectHeader(bytes);

      expect(result.check.status).toBe("passed");
    },
  );

  it("accepts the maximum permitted dimension and interlacing", async () => {
    const bytes = makeHeader();
    const view = new DataView(bytes.buffer);

    view.setUint32(16, 0x7fffffff, false);
    view.setUint32(20, 0x7fffffff, false);
    bytes[28] = 1;

    const { result } = await inspectHeader(bytes);

    // Format validity is separate from application dimension limits.
    expect(result.check.status).toBe("passed");
    expect(result.metadata.width).toBe(0x7fffffff);
    expect(result.metadata.height).toBe(0x7fffffff);
  });

  it("propagates budget exhaustion instead of reporting corruption", async () => {
    const reader = createFileReader(new Blob([makeHeader()]), {
      maxBytesRead: 32,
    });

    await detectFormat(reader); // Consumes eight bytes.

    // The 25-byte header read cannot fit into the remaining 24 bytes.
    await expect(inspectPngHeader(reader)).rejects.toMatchObject({
      code: "READ_BUDGET_EXCEEDED",
    });

    expect(reader.bytesRead).toBe(8);
    expect(reader.activeReads).toBe(0);
  });

  it("enforces the per-read limit independently of total budget", async () => {
    const reader = createFileReader(new Blob([makeHeader()]), {
      maxBytesRead: 100,
      maxReadSizeBytes: 24,
    });

    await detectFormat(reader);

    await expect(inspectPngHeader(reader)).rejects.toMatchObject({
      code: "READ_SIZE_EXCEEDED",
    });

    expect(reader.bytesRead).toBe(8);
  });

  it("honors cancellation between detection and header inspection", async () => {
    const controller = new AbortController();

    const reader = createFileReader(new Blob([makeHeader()]), {
      maxBytesRead: 33,
      signal: controller.signal,
    });

    await detectFormat(reader);
    controller.abort();

    await expect(inspectPngHeader(reader)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(reader.bytesRead).toBe(8);
    expect(reader.activeReads).toBe(0);
  });

  it("explicitly limits a pass to header fields, excluding CRC and image data", async () => {
    const { result } = await inspectHeader(makeHeader());

    // This deliberately incomplete image may pass only the scoped check.
    expect(result.check.status).toBe("passed");
    expect(result.check.scope).toContain(
      "CRC and image data not validated",
    );
  });
});
