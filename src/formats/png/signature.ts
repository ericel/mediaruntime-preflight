import type { FormatDetector } from "../contracts";

/** The eight bytes that identify a PNG signature. */
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
]);

export const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.byteLength;

/** Compare bytes without performing any file reads. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE_LENGTH) {
    return false;
  }

  for (let index = 0; index < PNG_SIGNATURE_LENGTH; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      return false;
    }
  }

  return true;
}

export const pngDetector: FormatDetector = {
  byteLength: PNG_SIGNATURE_LENGTH,
  matchReason: "The eight-byte PNG signature matches.",
  matches: hasPngSignature,
};
