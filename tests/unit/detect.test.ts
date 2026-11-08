import { describe, expect, it } from "vitest";

import { detectFormat } from "../../src/core/detect";
import { hasPngSignature } from "../../src/formats/png/signature";

import { createFileReader } from "../../src/core/reader";

/** Fresh signature bytes for each test. */
function pngSignature(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
  ]);
}

describe("Format detection", () => {
  it("recognizes the complete PNG signature", () => {
    expect(hasPngSignature(pngSignature())).toBe(true);
  });

  it("rejects a signature with one incorrect byte", () => {
    const bytes = pngSignature();
    bytes[0] = 0;

    expect(hasPngSignature(bytes)).toBe(false);
  });

  it("does not recognize an incomplete signature", () => {
    expect(hasPngSignature(pngSignature().slice(0, 7))).toBe(false);
  });

  it("detects PNG and preserves the bytes already read", async () => {
    const reader = createFileReader(new Blob([pngSignature()]), {
      maxBytesRead: 8,
    });

    const result = await detectFormat(reader);

    expect(result.detected).toEqual({
      format: "png",
      mime: "image/png",
    });
    expect(result.reason).toBe("signature_match");
    expect(result.prefix).toEqual(pngSignature());
    expect(reader.bytesRead).toBe(8);
  });

  it("reports insufficient data for a short file", async () => {
    const reader = createFileReader(
      new Blob([pngSignature().slice(0, 4)]),
      { maxBytesRead: 8 },
    );

    const result = await detectFormat(reader);

    expect(result.detected.format).toBe("unknown");
    expect(result.reason).toBe("insufficient_data");
    expect(reader.bytesRead).toBe(4);
  });

  it("handles an empty file without fetching bytes", async () => {
    const reader = createFileReader(new Blob([]), {
      maxBytesRead: 0,
    });

    const result = await detectFormat(reader);

    expect(result.reason).toBe("insufficient_data");
    expect(result.prefix.byteLength).toBe(0);
    expect(reader.bytesRead).toBe(0);
  });

  it("reports an unrecognized signature without claiming corruption", async () => {
    const reader = createFileReader(
      new Blob([new Uint8Array(8)]),
      { maxBytesRead: 8 },
    );

    const result = await detectFormat(reader);

    expect(result.detected).toEqual({
      format: "unknown",
      mime: null,
    });
    expect(result.reason).toBe("no_supported_signature");
  });

  it("propagates an insufficient read budget", async () => {
    const reader = createFileReader(new Blob([pngSignature()]), {
      maxBytesRead: 7,
    });

    await expect(detectFormat(reader)).rejects.toMatchObject({
      code: "READ_BUDGET_EXCEEDED",
    });

    expect(reader.bytesRead).toBe(0);
  });
});
