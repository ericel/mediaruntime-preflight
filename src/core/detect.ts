import type { DetectedFileType } from "../types";
import type { BoundedFileReader } from "./reader";
import { formatRegistry } from "./registry";

/** Internal result returned by format detection. */
export interface DetectionResult {
  /** Detected supported format, or unknown. */
  detected: DetectedFileType;

  /** Preserve fetched bytes so subsequent checks can reuse them. */
  prefix: Uint8Array;

  /** Explains the detection outcome without claiming file integrity. */
  reason:
    | "signature_match"
    | "insufficient_data"
    | "no_supported_signature";
}

/**
 * Detect formats using registered signature detectors and one shared read.
 * The longest registered signature bounds the read (currently eight bytes).
 *
 * Read failures, budget limits, and cancellation propagate to the caller.
 * Matching a signature does not establish whole-file validity.
 */
export async function detectFormat(
  reader: BoundedFileReader,
): Promise<DetectionResult> {
  const inspectors = Object.values(formatRegistry);
  const prefixLength = Math.max(
    0,
    ...inspectors.map((inspector) => inspector.signature.byteLength),
  );

  // Avoid requesting bytes beyond the end of short files.
  const length = Math.min(reader.sizeBytes, prefixLength);
  const prefix = await reader.read(0, length);

  for (const inspector of inspectors) {
    if (
      prefix.byteLength >= inspector.signature.byteLength &&
      inspector.signature.matches(prefix)
    ) {
      return {
        detected: { ...inspector.detected },
        prefix,
        reason: "signature_match",
      };
    }
  }

  return {
    detected: { format: "unknown", mime: null },
    prefix,
    reason: prefix.byteLength < prefixLength
      ? "insufficient_data"
      : "no_supported_signature",
  };
}
