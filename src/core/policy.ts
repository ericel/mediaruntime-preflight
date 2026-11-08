import type {
  DetectedFileType,
  FileInfo,
  FileMetadata,
  InspectionPolicy,
  PolicyResult,
  PolicyRuleId,
  PolicyRuleResult,
} from "../types";
import { formatRegistry } from "./registry";

/** Properties already obtained by inspection. */
export interface PolicyInput {
  file: FileInfo;
  detected: DetectedFileType;
  metadata: FileMetadata;
}

/**
 * Invalid configuration is a programming error,
 * not an indication that the inspected file is corrupt.
 */
export class PolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConfigurationError";
  }
}

/** Validate numerical policy limits before evaluating any rules. */
function validatePolicy(policy: InspectionPolicy): void {
  const numericRules = [
    "maxFileSizeBytes",
    "maxWidth",
    "maxHeight",
    "maxPixels",
  ] as const;

  for (const rule of numericRules) {
    const limit = policy[rule];

    // Omitted means unrestricted; zero is a valid explicit limit.
    if (limit === undefined) {
      continue;
    }

    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new PolicyConfigurationError(
        `${rule} must be a nonnegative safe integer.`,
      );
    }
  }

  if (policy.allowedFormats !== undefined) {
    if (!Array.isArray(policy.allowedFormats)) {
      throw new PolicyConfigurationError(
        "allowedFormats must be an array.",
      );
    }

    // Reserved format modules are not supported until they are registered.
    for (const format of policy.allowedFormats) {
      if (typeof format !== "string" || !Object.hasOwn(formatRegistry, format)) {
        throw new PolicyConfigurationError(
          `Unsupported allowed format: ${String(format)}.`,
        );
      }
    }
  }
}

/** Only established, valid dimensions may satisfy dimension rules. */
function isKnownDimension(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

/** Evaluate an upper bound when the actual value may be unavailable. */
function evaluateMaximum(
  rule: PolicyRuleId,
  actual: number | undefined,
  limit: number,
  label: string,
): PolicyRuleResult {
  if (actual === undefined) {
    return {
      rule,
      status: "undetermined",
      reason: `${label} was not established by inspection.`,
    };
  }

  if (actual > limit) {
    return {
      rule,
      status: "failed",
      reason: `${label} ${actual} exceeds the maximum ${limit}.`,
    };
  }

  return {
    rule,
    status: "passed",
    reason: `${label} ${actual} is within the maximum ${limit}.`,
  };
}

/**
 * Evaluate configured upload rules against available evidence.
 *
 * This does not certify file integrity or malware safety.
 * Missing metadata must never silently satisfy a configured rule.
 */
export function evaluatePolicy(
  input: PolicyInput,
  policy: InspectionPolicy = {},
): PolicyResult {
  validatePolicy(policy);

  const rules: PolicyRuleResult[] = [];
  const { file, detected, metadata } = input;

  if (policy.maxFileSizeBytes !== undefined) {
    const knownSize =
      Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0
        ? file.sizeBytes
        : undefined;

    rules.push(
      evaluateMaximum(
        "maxFileSizeBytes",
        knownSize,
        policy.maxFileSizeBytes,
        "File size in bytes",
      ),
    );
  }

  if (policy.allowedFormats !== undefined) {
    const allowed = policy.allowedFormats;

    if (allowed.length === 0) {
      // An explicitly empty allowlist permits no formats.
      rules.push({
        rule: "allowedFormats",
        status: "failed",
        reason: "The configured format allowlist is empty.",
      });
    } else if (detected.format === "unknown") {
      // Unknown is not evidence that the format is allowed or forbidden.
      rules.push({
        rule: "allowedFormats",
        status: "undetermined",
        reason: "The file format was not established by inspection.",
      });
    } else {
      const permitted = allowed.includes(detected.format);

      rules.push({
        rule: "allowedFormats",
        status: permitted ? "passed" : "failed",
        reason: permitted
          ? `Detected format "${detected.format}" is allowed.`
          : `Detected format "${detected.format}" is not allowed.`,
      });
    }
  }

  const width = isKnownDimension(metadata.width)
    ? metadata.width
    : undefined;

  const height = isKnownDimension(metadata.height)
    ? metadata.height
    : undefined;

  if (policy.maxWidth !== undefined) {
    rules.push(
      evaluateMaximum(
        "maxWidth",
        width,
        policy.maxWidth,
        "Image width",
      ),
    );
  }

  if (policy.maxHeight !== undefined) {
    rules.push(
      evaluateMaximum(
        "maxHeight",
        height,
        policy.maxHeight,
        "Image height",
      ),
    );
  }

  if (policy.maxPixels !== undefined) {
    if (width === undefined || height === undefined) {
      rules.push({
        rule: "maxPixels",
        status: "undetermined",
        reason: "Both image dimensions are required to evaluate pixel count.",
      });
    } else {
      const pixels = width * height;

      if (!Number.isSafeInteger(pixels)) {
        /**
         * Both dimensions are positive safe integers.
         * An unsafe product exceeds every permitted maxPixels limit,
         * since configuration requires that limit to be a safe integer.
         *
         * Reject without reporting an imprecise exact pixel count.
         */
        rules.push({
          rule: "maxPixels",
          status: "failed",
          reason:
            "The pixel count exceeds JavaScript's safe integer range " +
            "and therefore exceeds the configured maximum.",
        });
      } else {
        rules.push(
          evaluateMaximum(
            "maxPixels",
            pixels,
            policy.maxPixels,
            "Image pixel count",
          ),
        );
      }
    }
  }

  // A definite failure takes precedence over missing information.
  if (rules.some((result) => result.status === "failed")) {
    return { decision: "reject", rules };
  }

  if (rules.some((result) => result.status === "undetermined")) {
    return { decision: "undetermined", rules };
  }

  // Includes the case where the application configured no rules.
  return { decision: "allow", rules };
} 
