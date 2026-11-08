/**
 * Bounded range reading for MediaRuntime Preflight.
 *
 * Accepts Blob and File. Loads only explicitly requested slices.
 * No format parsing, network access, or worker messaging belongs here.
 */

export type ReaderErrorCode =
  | "INVALID_ARGUMENT"
  | "OUT_OF_BOUNDS"
  | "READ_SIZE_EXCEEDED"
  | "READ_BUDGET_EXCEEDED"
  | "CONCURRENT_READ_LIMIT"
  | "READ_FAILED";

/** Distinguishes resource limits from file-access failures. */
export class ReaderError extends Error {
  constructor(
    public readonly code: ReaderErrorCode,
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "ReaderError";
  }
}

export interface ReaderOptions {
  /** Total permitted bytes fetched during this inspection. */
  maxBytesRead: number;

  /** Maximum bytes in one read. Defaults to 64 KiB. */
  maxReadSizeBytes?: number;

  /** Maximum simultaneous nonempty reads. Defaults to one. */
  maxConcurrentReads?: number;

  /** Optional cancellation signal local to this execution context. */
  signal?: AbortSignal;
}

export interface BoundedFileReader {
  /** Source size; obtaining this does not read file contents. */
  readonly sizeBytes: number;

  /** Bytes successfully fetched, including repeated reads. */
  readonly bytesRead: number;

  /** Budget remaining after completed and pending reads. */
  readonly remainingBudgetBytes: number;

  /** Configured maximum size of one read. */
  readonly maxReadSizeBytes: number;

  /** Number of nonempty reads currently in progress. */
  readonly activeReads: number;

  /** Read exactly length bytes beginning at offset. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Conservative starting defaults; adjust after benchmarking. */
const DEFAULT_MAX_READ_SIZE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_READS = 1;

/** Validate offsets, lengths, and total budgets. */
function requireNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReaderError(
      "INVALID_ARGUMENT",
      `${name} must be a nonnegative safe integer.`,
    );
  }
}

/** Per-read size and concurrency limits must be greater than zero. */
function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReaderError(
      "INVALID_ARGUMENT",
      `${name} must be a positive safe integer.`,
    );
  }
}

/** Cancellation is distinct from a malformed file or exhausted budget. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      "File inspection was cancelled.",
      "AbortError",
    );
  }
}

/**
 * Create one reader per inspection.
 *
 * Repeated reads consume budget again; no cache is maintained.
 * Excess concurrent reads are rejected rather than queued.
 *
 * Limits bound requested I/O, not all browser memory:
 * callers remain responsible for releasing returned buffers.
 */
export function createFileReader(
  source: Blob,
  options: ReaderOptions,
): BoundedFileReader {
  // Capture configuration so later option mutations cannot change it.
  const sizeBytes = source.size;
  const maxBytesRead = options.maxBytesRead;
  const maxReadSizeBytes =
    options.maxReadSizeBytes ?? DEFAULT_MAX_READ_SIZE_BYTES;
  const maxConcurrentReads =
    options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS;
  const signal = options.signal;

  requireNonnegativeInteger(sizeBytes, "source.size");
  requireNonnegativeInteger(maxBytesRead, "maxBytesRead");
  requirePositiveInteger(maxReadSizeBytes, "maxReadSizeBytes");
  requirePositiveInteger(maxConcurrentReads, "maxConcurrentReads");

  let bytesRead = 0;
  let reservedBytes = 0;
  let activeReads = 0;

  return {
    get sizeBytes(): number {
      return sizeBytes;
    },

    get bytesRead(): number {
      return bytesRead;
    },

    get remainingBudgetBytes(): number {
      return maxBytesRead - bytesRead - reservedBytes;
    },

    get maxReadSizeBytes(): number {
      return maxReadSizeBytes;
    },

    get activeReads(): number {
      return activeReads;
    },

    async read(offset: number, length: number): Promise<Uint8Array> {
      throwIfAborted(signal);

      requireNonnegativeInteger(offset, "offset");
      requireNonnegativeInteger(length, "length");

      // Subtraction avoids overflow in offset + length.
      // A zero-length read exactly at EOF is valid.
      if (offset > sizeBytes || length > sizeBytes - offset) {
        throw new ReaderError(
          "OUT_OF_BOUNDS",
          `Cannot read ${length} bytes at offset ${offset} ` +
            `from a ${sizeBytes}-byte file.`,
        );
      }

      // Enforce allocation size independently of the total read budget.
      if (length > maxReadSizeBytes) {
        throw new ReaderError(
          "READ_SIZE_EXCEEDED",
          `Requested ${length} bytes in one read; ` +
            `the per-read limit is ${maxReadSizeBytes} bytes.`,
        );
      }

      const remainingBudget =
        maxBytesRead - bytesRead - reservedBytes;

      if (length > remainingBudget) {
        throw new ReaderError(
          "READ_BUDGET_EXCEEDED",
          `Requested ${length} bytes, but only ` +
            `${remainingBudget} budget bytes remain.`,
        );
      }

      // Empty reads require neither I/O nor a concurrency slot.
      if (length === 0) {
        return new Uint8Array(0);
      }

      if (activeReads >= maxConcurrentReads) {
        throw new ReaderError(
          "CONCURRENT_READ_LIMIT",
          `At most ${maxConcurrentReads} reads may run simultaneously.`,
        );
      }

      // Reserve budget and a slot before yielding at await.
      reservedBytes += length;
      activeReads += 1;

      try {
        let buffer: ArrayBuffer;

        try {
          // Only this slice is materialized, never the entire source.
          buffer = await source
            .slice(offset, offset + length)
            .arrayBuffer();
        } catch (error: unknown) {
          throwIfAborted(signal);

          throw new ReaderError(
            "READ_FAILED",
            `Failed to read ${length} bytes at offset ${offset}.`,
            error,
          );
        }

        // Count completed I/O even if cancellation occurred during it.
        bytesRead += buffer.byteLength;

        throwIfAborted(signal);

        // Blob.slice().arrayBuffer() should return the exact range.
        if (buffer.byteLength !== length) {
          throw new ReaderError(
            "READ_FAILED",
            `Expected ${length} bytes, received ${buffer.byteLength}.`,
          );
        }

        // A view over the existing buffer; no additional byte copy.
        return new Uint8Array(buffer);
      } finally {
        // Cleanup runs after success, failure, or cancellation.
        reservedBytes -= length;
        activeReads -= 1;
      }
    },
  };
}