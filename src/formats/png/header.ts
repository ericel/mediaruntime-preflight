import type { BoundedFileReader } from "../../core/reader";
import type { FormatCheck, FormatCheckResult } from "../contracts";
import { PNG_SIGNATURE_LENGTH } from "./signature";


/** Result of inspecting the PNG header, not the complete image. */
export type PngHeaderResult = FormatCheckResult;

const IHDR_DATA_LENGTH = 13;

// Chunk length + chunk type + header data + CRC.
const IHDR_CHUNK_LENGTH = 4 + 4 + IHDR_DATA_LENGTH + 4;

// Signature followed by the complete first chunk.
const MIN_HEADER_FILE_SIZE =
  PNG_SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH;

const MAX_PNG_DIMENSION = 0x7fffffff;

// ASCII bytes for "IHDR", interpreted as a big-endian integer.
const IHDR_CHUNK_TYPE = 0x49484452;

const HEADER_SCOPE =
  "First IHDR chunk structure and fields; CRC and image data not validated.";

/** PNG permits specific bit depths for each color type. */
function isValidBitDepth(
  colorType: number,
  bitDepth: number,
): boolean {
  switch (colorType) {
    case 0: // Grayscale.
      return [1, 2, 4, 8, 16].includes(bitDepth);

    case 2: // RGB.
    case 4: // Grayscale with alpha.
    case 6: // RGB with alpha.
      return bitDepth === 8 || bitDepth === 16;

    case 3: // Indexed color.
      return [1, 2, 4, 8].includes(bitDepth);

    default:
      return false;
  }
}

/** Build a consistent failed result without exposing invalid metadata. */
function failHeader(
  code: string,
  message: string,
  offsetBytes: number,
): PngHeaderResult {
  return {
    check: {
      id: "png.header",
      status: "failed",
      scope: HEADER_SCOPE,
      reason: message,
    },
    metadata: {},
    findings: [
      {
        code,
        severity: "error",
        checkId: "png.header",
        message,
        offsetBytes,
      },
    ],
  };
}

/**
 * Inspect the first PNG chunk after signature detection succeeds.
 *
 * Precondition: detectFormat() identified PNG using this same file.
 * The signature is not read again.
 *
 * Reads 25 additional bytes at most.
 * Resource-limit, cancellation, and I/O errors propagate to the caller.
 */
export async function inspectPngHeader(
  reader: BoundedFileReader,
): Promise<PngHeaderResult> {
  // Check availability before requesting an exact-range read.
  if (reader.sizeBytes < MIN_HEADER_FILE_SIZE) {
    return failHeader(
      "PNG_HEADER_TRUNCATED",
      "The file is too short to contain a complete PNG IHDR chunk.",
      reader.sizeBytes,
    );
  }

  const bytes = await reader.read(
    PNG_SIGNATURE_LENGTH,
    IHDR_CHUNK_LENGTH,
  );

  // Respect the typed array's offset and length within its buffer.
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  // PNG integers are big-endian: false means not little-endian.
  const dataLength = view.getUint32(0, false);
  const chunkType = view.getUint32(4, false);

  if (chunkType !== IHDR_CHUNK_TYPE) {
    return failHeader(
      "PNG_IHDR_MISSING",
      "The first PNG chunk must be IHDR.",
      12,
    );
  }

  if (dataLength !== IHDR_DATA_LENGTH) {
    return failHeader(
      "PNG_IHDR_LENGTH_INVALID",
      "IHDR must contain exactly 13 bytes of data.",
      8,
    );
  }

  // These offsets are relative to our slice, which starts at file byte 8.
  const width = view.getUint32(8, false);
  const height = view.getUint32(12, false);
  const bitDepth = view.getUint8(16);
  const colorType = view.getUint8(17);
  const compression = view.getUint8(18);
  const filter = view.getUint8(19);
  const interlace = view.getUint8(20);

  if (width === 0 || width > MAX_PNG_DIMENSION) {
    return failHeader(
      "PNG_WIDTH_INVALID",
      "PNG width must be between 1 and 2,147,483,647 pixels.",
      16,
    );
  }

  if (height === 0 || height > MAX_PNG_DIMENSION) {
    return failHeader(
      "PNG_HEIGHT_INVALID",
      "PNG height must be between 1 and 2,147,483,647 pixels.",
      20,
    );
  }

  if (![0, 2, 3, 4, 6].includes(colorType)) {
    return failHeader(
      "PNG_COLOR_TYPE_INVALID",
      `Unsupported PNG color-type value: ${colorType}.`,
      25,
    );
  }

  if (!isValidBitDepth(colorType, bitDepth)) {
    return failHeader(
      "PNG_BIT_DEPTH_INVALID",
      `Bit depth ${bitDepth} is invalid for color type ${colorType}.`,
      24,
    );
  }

  if (compression !== 0) {
    return failHeader(
      "PNG_COMPRESSION_INVALID",
      "PNG compression method must be 0.",
      26,
    );
  }

  if (filter !== 0) {
    return failHeader(
      "PNG_FILTER_INVALID",
      "PNG filter method must be 0.",
      27,
    );
  }

  if (interlace !== 0 && interlace !== 1) {
    return failHeader(
      "PNG_INTERLACE_INVALID",
      "PNG interlace method must be 0 or 1.",
      28,
    );
  }

  // CRC bytes are present in the slice but are not validated yet.
  return {
    check: {
      id: "png.header",
      status: "passed",
      scope: HEADER_SCOPE,
    },
    metadata: {
      width,
      height,
    },
    findings: [],
  };
}

/** The coordinator uses this definition without knowing PNG-specific details. */
/** Adapt the existing PNG parser to the shared check interface. */
export const pngHeaderCheck: FormatCheck = {
  id: "png.header",

  scope:
    "First IHDR chunk structure and fields; CRC and image data not validated.",

  notDetectedReason:
    "PNG header inspection requires a detected PNG signature.",

  async inspect(context) {
    // Check the shared deadline and cancellation before parsing.
    context.checkpoint();

    // Keep the existing parser and its tests unchanged.
    return inspectPngHeader(context.reader);
  },
};
