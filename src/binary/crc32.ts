/**
 * Incremental CRC-32 for PNG-compatible checksums.
 *
 * No file access, format parsing, or worker dependencies belong here.
 * Callers control buffer sizes and checkpoint between updates.
 */

const POLYNOMIAL = 0xedb88320;
const INITIAL_STATE = 0xffffffff;

/** Build a shared 1 KiB lookup table once per module instance. */
function createLookupTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? (value >>> 1) ^ POLYNOMIAL
        : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

const LOOKUP_TABLE = createLookupTable();

/**
 * A running checksum.
 *
 * Each instance retains only its numeric state, not input buffers.
 * digest() is non-destructive: updates can continue afterward.
 */
export class Crc32 {
  private state = INITIAL_STATE;

  /** Process the bytes in this view without copying or retaining them. */
  update(bytes: Uint8Array): void {
    let state = this.state;

    for (let index = 0; index < bytes.length; index += 1) {
      const tableIndex = (state ^ bytes[index]!) & 0xff;

      state = LOOKUP_TABLE[tableIndex]! ^ (state >>> 8);
    }

    // JavaScript bitwise operators can produce signed values.
    this.state = state >>> 0;
  }

  /** Return the finalized checksum as an unsigned 32-bit number. */
  digest(): number {
    return (this.state ^ INITIAL_STATE) >>> 0;
  }

  /** Start a new checksum without allocating another instance. */
  reset(): void {
    this.state = INITIAL_STATE;
  }
}

/** Convenience function for an already available byte buffer. */
export function crc32(bytes: Uint8Array): number {
  const checksum = new Crc32();
  checksum.update(bytes);
  return checksum.digest();
}