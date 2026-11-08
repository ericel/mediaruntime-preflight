import type { BoundedFileReader } from "../core/reader";

import type {
  CheckId,
  CheckResult,
  DetectedFileType,
  FileMetadata,
  Finding,
} from "../types";

/** Evidence returned by one format-specific check. */
export interface FormatCheckResult {
  check: CheckResult;
  metadata: FileMetadata;
  findings: Finding[];
}

/** Resources shared by checks within one inspection. */
export interface FormatCheckContext {
  /** All reads count against the inspection's shared byte budget. */
  readonly reader: BoundedFileReader;

  /** Bytes already fetched during detection; treat as read-only. */
  readonly prefix: Uint8Array;

  /** Cancellation signal local to this execution context. */
  readonly signal?: AbortSignal;

  /**
   * Throws when cancellation or the inspection deadline is reached.
   *
   * Checks should call this before reads and inside processing loops.
   * Let these errors propagate to the coordinator.
   */
  readonly checkpoint: () => void;
}

/** A signature detector operates on a shared prefix without additional I/O. */
export interface FormatDetector {
  readonly byteLength: number;
  readonly matchReason: string;

  /** A signature match identifies a format, not whole-file validity. */
  matches(prefix: Uint8Array): boolean;
}

/** A check that runs after this format's signature has been established. */
export interface FormatCheck {
  readonly id: CheckId;
  readonly scope: string;
  readonly notDetectedReason: string;

  /**
   * Return evidence for this check.
   * Operational errors and resource limits propagate to the coordinator.
   */
  inspect(context: FormatCheckContext): Promise<FormatCheckResult>;
}

/** Only implemented formats belong in the registry. */
export interface FormatInspector {
  readonly detected: Exclude<
    DetectedFileType,
    { format: "unknown" }
  >;

  /** Accepted lowercase filename extensions, without leading dots. */
  readonly extensions: readonly string[];

  readonly signature: FormatDetector;

  /** Checks currently run by the coordinator, in execution order. */
  readonly checks: readonly FormatCheck[];
}