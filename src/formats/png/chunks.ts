import type { FormatCheckContext } from "../contracts";

/** Errors describing malformed chunk framing, not operational failures. */
export type PngChunkErrorCode =
  | "PNG_CHUNK_TRUNCATED"
  | "PNG_CHUNK_LENGTH_INVALID"
  | "PNG_CHUNK_TYPE_INVALID"
  | "PNG_IEND_LENGTH_INVALID"
  | "PNG_IEND_MISSING";

export class PngChunkError extends Error {
  constructor(
    public readonly code: PngChunkErrorCode,
    message: string,
    public readonly offsetBytes: number,
  ) {
    super(message);
    this.name = "PngChunkError";
  }
}

/** Chunk locations; payload and CRC contents have not been read. */
export interface PngChunk {
  readonly type: string;
  readonly offsetBytes: number;
  readonly dataOffsetBytes: number;
  readonly dataLengthBytes: number;
  readonly crcOffsetBytes: number;
  readonly endOffsetBytes: number;
}

/**
 * Read one chunk header and validate its enclosing byte range.
 *
 * Preconditions:
 * - PNG signature detection has already succeeded.
 * - offsetBytes identifies an expected chunk boundary.
 *
 * This does not validate CRCs, payloads, ordering, or required chunks.
 * Reader errors and checkpoint errors propagate unchanged.
 */
export async function readPngChunk(
  context: FormatCheckContext,
  offsetBytes: number,
): Promise<PngChunk> {
  context.checkpoint();

  const { reader } = context;

  // Invalid caller offsets are programming errors, not file corruption.
  if (
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 8 ||
    offsetBytes > reader.sizeBytes
  ) {
    throw new RangeError(
      "Chunk offset must be a safe integer between 8 and the file size.",
    );
  }

  const remaining = reader.sizeBytes - offsetBytes;

  // Even an empty chunk requires an eight-byte header and four-byte CRC.
  if (remaining < 12) {
    throw new PngChunkError(
      "PNG_CHUNK_TRUNCATED",
      "Insufficient bytes for a complete chunk envelope.",
      offsetBytes,
    );
  }

  const header = await reader.read(offsetBytes, 8);
  context.checkpoint();

  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );

  const dataLengthBytes = view.getUint32(0, false);

  if (dataLengthBytes > 0x7fffffff) {
    throw new PngChunkError(
      "PNG_CHUNK_LENGTH_INVALID",
      "PNG chunk data length exceeds the permitted maximum.",
      offsetBytes,
    );
  }

  // Check via subtraction before calculating absolute end offsets.
  if (dataLengthBytes > remaining - 12) {
    throw new PngChunkError(
      "PNG_CHUNK_TRUNCATED",
      "Chunk data or its CRC extends beyond the file.",
      offsetBytes,
    );
  }

  // PNG type bytes must be ASCII letters.
  for (let index = 4; index < 8; index += 1) {
    const byte = header[index]!;
    const uppercase = byte >= 0x41 && byte <= 0x5a;
    const lowercase = byte >= 0x61 && byte <= 0x7a;

    if (!uppercase && !lowercase) {
      throw new PngChunkError(
        "PNG_CHUNK_TYPE_INVALID",
        "PNG chunk type must contain four ASCII letters.",
        offsetBytes + index,
      );
    }
  }

  const type = String.fromCharCode(
    header[4]!,
    header[5]!,
    header[6]!,
    header[7]!,
  );

  const dataOffsetBytes = offsetBytes + 8;
  const crcOffsetBytes = dataOffsetBytes + dataLengthBytes;

  return {
    type,
    offsetBytes,
    dataOffsetBytes,
    dataLengthBytes,
    crcOffsetBytes,
    endOffsetBytes: crcOffsetBytes + 4,
  };
}

/**
 * Yield chunk locations from immediately after the PNG signature to IEND.
 *
 * Payloads and CRCs are skipped, not validated. Each iteration reads
 * eight bytes, regardless of the chunk's declared payload size.
 *
 * This iterator:
 * - checks chunk framing;
 * - requires an empty IEND to terminate;
 * - leaves ordering, required image chunks, and trailing-byte policy
 *   to the future integrity inspector.
 *
 * Consumers must fully iterate to establish that IEND was reached.
 * Breaking early establishes only the boundaries already examined.
 */
export async function* iteratePngChunks(
  context: FormatCheckContext,
): AsyncGenerator<PngChunk, void, unknown> {
  let offsetBytes = 8;

  while (offsetBytes < context.reader.sizeBytes) {
    const chunk = await readPngChunk(context, offsetBytes);

    if (chunk.type === "IEND" && chunk.dataLengthBytes !== 0) {
      throw new PngChunkError(
        "PNG_IEND_LENGTH_INVALID",
        "IEND must have an empty data field.",
        chunk.offsetBytes,
      );
    }

    yield chunk;

    // Resume cancellation/deadline checks after the consumer's work.
    context.checkpoint();

    if (chunk.type === "IEND") {
      return;
    }

    // Every chunk occupies at least twelve bytes, guaranteeing progress.
    offsetBytes = chunk.endOffsetBytes;
  }

  context.checkpoint();

  throw new PngChunkError(
    "PNG_IEND_MISSING",
    "The PNG chunk sequence ended without IEND.",
    offsetBytes,
  );
}