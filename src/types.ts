/**
 * Public contracts for MediaRuntime Preflight.
 *
 * These types describe inspection requests and reports.
 * They do not perform any file inspection.
 */

/** Only PNG inspection is implemented in the first milestone. */
export type SupportedFormat = "png";

/** Outcome of one specific inspection check. */
export type CheckStatus =
  | "passed"
  | "failed"
  | "inconclusive"
  | "unsupported"
  | "not_checked";

/** Compliance with configured rules, not a guarantee of file safety. */
export type PolicyDecision = "allow" | "reject" | "undetermined";

/** Severity describes a finding, independently of upload policy. */
export type FindingSeverity = "info" | "warning" | "error";

/** Identifiers for the checks planned for our first milestone. */
/**
 * Checks supported by our first implementation.
 *
 * A recognized identifier does not mean the check was performed.
 * Integrity and malware remain explicitly not_checked for now.
 */
export type CoreCheckId =
  | "file.size"             // Evaluate the configured file-size limit.
  | "format.signature"     // Inspect bytes for a supported format signature.
  | "format.declared_mime"  // Compare declared MIME with detected format.
  | "format.extension"      // Compare filename extension with detected format.
  | "png.header"            // Validate the supported PNG header fields.
  | "file.integrity"        // Report integrity checks with explicit scope.
  | "file.malware";         // Reserved; no antivirus implementation yet.

/**
 * Planned checks.
 *
 * These are design identifiers, not currently supported capabilities.
 * Promote each identifier into CheckId when its contract is implemented.
 */
export type PlannedCheckId =
  // Media properties evaluated against application rules.
  | "media.dimensions"      // Width, height, and total pixel limits.
  | "media.duration"        // Duration limits.
  | "media.codec"           // Allowed codec rules.
  | "media.colorspace"      // Allowed or required color-space rules.
  | "media.encryption"     // Detect supported encryption indicators.

  // Metadata and potentially dangerous file features.
  | "metadata.exif"             // Detect selected EXIF fields, such as GPS.
  | "svg.active_content"        // Detect prohibited SVG active features.
  | "file.polyglot_indicators"  // Detect supported multiple-format indicators.
  | "archive.expansion_limits" // Enforce bounded archive expansion rules.

  // Checks requiring application-provided rules or reference data.
  | "file.name"            // Evaluate filename rules without changing the name.
  | "file.duplicate"       // Compare against a defined reference set.

  // Optional content analysis with separately defined engines and thresholds.
  | "content.nsfw"             // Model-based classification, not certainty.
  | "content.reference_match"; // Match references, not determine legal rights.

/** The currently exposed inspection-check contract. */
export type CheckId = CoreCheckId;

/** Application-defined upload restrictions. */
export interface InspectionPolicy {
  /** Maximum file size in bytes. Omitted means no size restriction. */
  maxFileSizeBytes?: number;

  /** Allowed detected formats. Omitted means no format restriction. */
  allowedFormats?: readonly SupportedFormat[];

  /** Maximum image width in pixels. */
  maxWidth?: number;

  /** Maximum image height in pixels. */
  maxHeight?: number;

  /** Maximum width multiplied by height. */
  maxPixels?: number;
}

/** Resource limits for inspection, separate from upload policy. */
export interface InspectionLimits {
  /** Maximum total bytes fetched from the file during inspection. */
  maxBytesRead?: number;

  /**
   * Cooperative execution budget in milliseconds.
   * Checked between operations; not a hard real-time deadline.
   */
  maxInspectionTimeMs?: number;
}

/** Options accepted by the public inspection function. */
export interface InspectionOptions {
  policy?: InspectionPolicy;
  limits?: InspectionLimits;

  /** Stop additional checks after a definite policy rejection. */
  stopOnPolicyRejection?: boolean;

  /** Allows the application to cancel this request. */
  signal?: AbortSignal;
}

/** Original file properties; name and declared MIME are untrusted. */
export interface FileInfo {
  name: string;
  sizeBytes: number;

  /** May be an empty string when the browser supplies no MIME type. */
  declaredMime: string;
}

/**
 * A discriminated union prevents contradictory format/MIME combinations.
 * Unknown means we did not establish a supported format.
 */
export type DetectedFileType =
  | {
      format: "png";
      mime: "image/png";
    }
  | {
      format: "unknown";
      mime: null;
    };

/** Metadata established by the parser; absent values remain unknown. */
export interface FileMetadata {
  width?: number;
  height?: number;
}

/** Result of one narrowly defined check. */
export interface CheckResult {
  id: CheckId;
  status: CheckStatus;

  /** Explains what was examined, such as "PNG signature bytes". */
  scope: string;

  /** Optional explanation of failure, uncertainty, or skipped work. */
  reason?: string;
}

/** A specific observation made during inspection. */
export interface Finding {
  /**
   * Stable machine-readable code, for example "PNG_HEADER_TRUNCATED".
   * Applications should use this code rather than parse message text.
   */
  code: string;

  severity: FindingSeverity;
  checkId: CheckId;
  message: string;

  /** Byte offset associated with the finding, when known. */
  offsetBytes?: number;
}

/** Names correspond to the configurable upload rules. */
export type PolicyRuleId = keyof InspectionPolicy;

/** Individual policy-rule outcome. */
export interface PolicyRuleResult {
  rule: PolicyRuleId;
  status: "passed" | "failed" | "undetermined";
  reason?: string;
}

/** Overall policy outcome with the evidence behind it. */
export interface PolicyResult {
  decision: PolicyDecision;
  rules: PolicyRuleResult[];
}

/** Why inspection could not cover all intended work. */
export interface CoverageLimitation {
  code:
    | "unsupported_format"
    | "byte_budget_exhausted"
    | "time_budget_exhausted"
    | "early_policy_rejection"
    | "check_not_implemented";

  message: string;
  checkId?: CheckId;
}

/** Makes partial inspection explicit. */
export interface InspectionCoverage {
  /** Checks that reached a definite passed or failed result. */
  completedChecks: CheckId[];

  /** Checks that did not reach a definite result. */
  incompleteChecks: CheckId[];

  limitations: CoverageLimitation[];
}

/** Measurements describing this particular request. */
export interface InspectionMetrics {
  /** Caller-observed elapsed time, including startup and queueing. */
  totalDurationMs: number;

  /** Time spent executing the inspection inside the worker. */
  inspectionDurationMs: number;

  /** Actual bytes fetched; repeated reads count unless cached. */
  bytesRead: number;
}

/** Public result returned by a successful inspection request. */
export interface InspectionReport {
  schemaVersion: "0.1";
  file: FileInfo;
  detected: DetectedFileType;
  metadata: FileMetadata;
  checks: CheckResult[];
  findings: Finding[];
  policy: PolicyResult;
  coverage: InspectionCoverage;
  metrics: InspectionMetrics;
}