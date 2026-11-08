import type {
  CheckId,
  CheckResult,
  CoverageLimitation,
  DetectedFileType,
  FileInfo,
  FileMetadata,
  Finding,
  InspectionOptions,
  InspectionReport,
} from "../types";

import { createFileReader, ReaderError } from "./reader";
import { detectFormat } from "./detect";
import { evaluatePolicy } from "./policy";
import { formatRegistry } from "./registry";

/** Default resource limits for fast inspection. */
const DEFAULT_MAX_BYTES_READ = 64 * 1024;
const DEFAULT_TIME_BUDGET_MS = 100;

/** Internal error converted into incomplete inspection coverage. */
class InspectionTimeLimitError extends Error {
  constructor() {
    super("The inspection time budget was exhausted.");
    this.name = "InspectionTimeLimitError";
  }
}

/** Collect checks from implemented, registered formats. */
const FORMAT_CHECKS = Object.values(formatRegistry).flatMap(
  (inspector) => inspector.checks,
);

/** Describe checks without implying they have been performed. */
const CHECK_DEFINITIONS: readonly Pick<
  CheckResult,
  "id" | "scope"
>[] = [
  {
    id: "file.size",
    scope: "File byte size against the configured maximum.",
  },
  {
    id: "format.signature",
    scope: "Supported file signatures at the beginning of the file.",
  },
  {
    id: "format.declared_mime",
    scope: "Declared MIME compared with detected MIME.",
  },
  {
    id: "format.extension",
    scope: "Filename extension compared with detected format.",
  },
  ...FORMAT_CHECKS.map(({ id, scope }) => ({ id, scope })),
  {
    id: "file.integrity",
    scope: "Whole-file structural and decoding validation.",
  },
  {
    id: "file.malware",
    scope: "Malware scanning.",
  },
];

/** Cancellation rejects the inspection instead of reporting corruption. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      "File inspection was cancelled.",
      "AbortError",
    );
  }
}

/** Get a lowercase extension; a lone dotfile has no extension. */
function getExtension(name: string): string | undefined {
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || dot === name.length - 1) {
    return undefined;
  }

  return name.slice(dot + 1).toLowerCase();
}

/**
 * Inspect a browser File using registered format checks.
 *
 * No DOM, upload, or worker messaging belongs here.
 *
 * Resource exhaustion returns a report with incomplete coverage.
 * Cancellation, invalid configuration, and I/O failures reject.
 */
export async function inspectFile(
  source: File,
  options: InspectionOptions = {},
): Promise<InspectionReport> {
  const startedAt = performance.now();

  // Capture configuration before the first asynchronous operation.
  const signal = options.signal;
  const stopOnPolicyRejection =
    options.stopOnPolicyRejection ?? false;

  const maxBytesRead =
    options.limits?.maxBytesRead ?? DEFAULT_MAX_BYTES_READ;

  const maxInspectionTimeMs =
    options.limits?.maxInspectionTimeMs ??
    DEFAULT_TIME_BUDGET_MS;

  // Caller mutations must not change policy during an inspection.
  const policy = structuredClone(options.policy ?? {});

  throwIfAborted(signal);

  if (typeof stopOnPolicyRejection !== "boolean") {
    throw new TypeError(
      "stopOnPolicyRejection must be a boolean.",
    );
  }

  if (
    !Number.isFinite(maxInspectionTimeMs) ||
    maxInspectionTimeMs < 0
  ) {
    throw new TypeError(
      "maxInspectionTimeMs must be a finite nonnegative number.",
    );
  }

  const reader = createFileReader(source, {
    maxBytesRead,

    // Omit absent optional properties for strict TypeScript compatibility.
    ...(signal === undefined ? {} : { signal }),
  });

  const file: FileInfo = {
    name: source.name,
    sizeBytes: reader.sizeBytes,
    declaredMime: source.type,
  };

  let detected: DetectedFileType = {
    format: "unknown",
    mime: null,
  };

  let metadata: FileMetadata = {};

  const findings: Finding[] = [];
  const limitations: CoverageLimitation[] = [];
  const checks = new Map<CheckId, CheckResult>();

  // Initialize every current check so missing coverage is explicit.
  for (const { id, scope } of CHECK_DEFINITIONS) {
    checks.set(id, {
      id,
      status: "not_checked",
      scope,
      reason: "This check has not been performed.",
    });
  }

  /** Update a check while preserving its declared scope. */
  function setCheck(
    id: CheckId,
    status: CheckResult["status"],
    reason: string,
  ): void {
    const check = checks.get(id);

    if (!check) {
      throw new Error(
        `No registered definition for check "${id}".`,
      );
    }

    checks.set(id, {
      ...check,
      status,
      reason,
    });
  }

  // These capabilities remain unimplemented in this milestone.
  for (const id of ["file.integrity", "file.malware"] as const) {
    const message =
      "This check is not implemented in this milestone.";

    setCheck(id, "not_checked", message);

    limitations.push({
      code: "check_not_implemented",
      checkId: id,
      message,
    });
  }

  // Validate policy before reading content. Size or an empty format
  // allowlist may already establish a rejection.
  const initialPolicy = evaluatePolicy(
    { file, detected, metadata },
    policy,
  );

  /** Enforce cancellation and the cooperative deadline. */
  function checkpoint(): void {
    throwIfAborted(signal);

    if (
      performance.now() - startedAt >= maxInspectionTimeMs
    ) {
      throw new InspectionTimeLimitError();
    }
  }

  /** Compare a declaration against one or more accepted values. */
  function compareDeclaration(
    id: "format.declared_mime" | "format.extension",
    actual: string | undefined,
    expected: string | readonly string[],
    findingCode: string,
  ): void {
    if (!actual) {
      setCheck(
        id,
        "not_checked",
        "No declaration was supplied.",
      );
      return;
    }

    // MIME uses one value; extensions can include aliases.
    const accepted =
      typeof expected === "string" ? [expected] : expected;

    const matches = accepted.includes(actual);

    // Retain existing wording when only one value is accepted.
    const expectedDescription =
      accepted.length === 1
        ? `"${accepted[0]}"`
        : `one of [${
            accepted.map((value) => `"${value}"`).join(", ")
          }]`;

    const message = matches
      ? `Declaration "${actual}" matches ${expectedDescription}.`
      : `Declaration "${actual}" does not match ${expectedDescription}.`;

    setCheck(
      id,
      matches ? "passed" : "failed",
      message,
    );

    if (!matches) {
      findings.push({
        code: findingCode,
        severity: "warning",
        checkId: id,
        message,
      });
    }
  }

  /** Evaluate policy and assemble the report from recorded evidence. */
  function finish(): InspectionReport {
    throwIfAborted(signal);

    const policyResult = evaluatePolicy(
      { file, detected, metadata },
      policy,
    );

    // Reuse policy evaluation instead of duplicating the size comparison.
    const sizeRule = policyResult.rules.find(
      (rule) => rule.rule === "maxFileSizeBytes",
    );

    if (sizeRule) {
      setCheck(
        "file.size",
        sizeRule.status === "undetermined"
          ? "inconclusive"
          : sizeRule.status,
        sizeRule.reason ?? "File-size policy evaluated.",
      );
    } else {
      setCheck(
        "file.size",
        "not_checked",
        "No maximum file size was configured.",
      );
    }

    const results = [...checks.values()];

    const completed = results.filter(
      (check) =>
        check.status === "passed" ||
        check.status === "failed",
    );

    const incomplete = results.filter(
      (check) =>
        check.status !== "passed" &&
        check.status !== "failed",
    );

    const elapsed = performance.now() - startedAt;

    return {
      schemaVersion: "0.1",
      file,
      detected,
      metadata,
      checks: results,
      findings,
      policy: policyResult,
      coverage: {
        completedChecks: completed.map((check) => check.id),
        incompleteChecks: incomplete.map((check) => check.id),
        limitations,
      },
      metrics: {
        // Both measure this invocation here. The worker client replaces
        // totalDurationMs with caller-observed time, including transport.
        totalDurationMs: elapsed,
        inspectionDurationMs: elapsed,
        bytesRead: reader.bytesRead,
      },
    };
  }

  if (
    stopOnPolicyRejection &&
    initialPolicy.decision === "reject"
  ) {
    const message =
      "Content inspection skipped after policy rejection.";

    for (const id of [
      "format.signature",
      "format.declared_mime",
      "format.extension",
      ...FORMAT_CHECKS.map((check) => check.id),
    ] as const) {
      setCheck(id, "not_checked", message);
    }

    limitations.push({
      code: "early_policy_rejection",
      message,
    });

    return finish();
  }

  // Identify the check interrupted by a resource limit.
  let activeCheck: CheckId = "format.signature";

  try {
    checkpoint();

    const detection = await detectFormat(reader);
    detected = detection.detected;

    if (detected.format === "unknown") {
      const message =
        detection.reason === "insufficient_data"
          ? "Too few bytes to establish a supported signature."
          : "No supported signature was recognized.";

      setCheck(
        "format.signature",
        "inconclusive",
        message,
      );

      setCheck(
        "format.declared_mime",
        "inconclusive",
        "Cannot compare MIME without a detected format.",
      );

      setCheck(
        "format.extension",
        "inconclusive",
        "Cannot compare extension without a detected format.",
      );

      for (const check of FORMAT_CHECKS) {
        setCheck(
          check.id,
          "not_checked",
          check.notDetectedReason,
        );
      }

      limitations.push({
        code: "unsupported_format",
        message,
      });
    } else {
      const inspector = formatRegistry[detected.format];

      setCheck(
        "format.signature",
        "passed",
        inspector.signature.matchReason,
      );

      // Declaration comparisons require no additional file reads.
      compareDeclaration(
        "format.declared_mime",
        file.declaredMime.trim().toLowerCase(),
        detected.mime,
        "DECLARED_MIME_MISMATCH",
      );

      // Accept aliases declared by the format module.
      // For example, a future JPEG module can accept "jpg" and "jpeg".
      compareDeclaration(
        "format.extension",
        getExtension(file.name),
        inspector.extensions,
        "FILE_EXTENSION_MISMATCH",
      );

      // Explain why checks belonging to other formats do not run.
      for (const check of FORMAT_CHECKS) {
        if (!inspector.checks.includes(check)) {
          setCheck(
            check.id,
            "not_checked",
            check.notDetectedReason,
          );
        }
      }

      for (const check of inspector.checks) {
        activeCheck = check.id;
        checkpoint();

        // All checks share byte accounting and the same deadline.
        const result = await check.inspect({
          reader,
          prefix: detection.prefix,
          checkpoint,
          ...(signal === undefined ? {} : { signal }),
        });

        // Preserve each check's precise scope and evidence.
        checks.set(check.id, result.check);
        metadata = { ...metadata, ...result.metadata };
        findings.push(...result.findings);
      }
    }
  } catch (error: unknown) {
    let limitCode: CoverageLimitation["code"];
    let message: string;

    if (
      error instanceof ReaderError &&
      error.code === "READ_BUDGET_EXCEEDED"
    ) {
      limitCode = "byte_budget_exhausted";
      message = error.message;
    } else if (error instanceof InspectionTimeLimitError) {
      limitCode = "time_budget_exhausted";
      message = error.message;
    } else {
      // Preserve aborts, I/O failures, and programming errors.
      throw error;
    }

    setCheck(activeCheck, "inconclusive", message);

    limitations.push({
      code: limitCode,
      checkId: activeCheck,
      message,
    });

    // Explain why remaining checks never ran.
    for (const id of [
      "format.declared_mime",
      "format.extension",
      ...FORMAT_CHECKS.map((check) => check.id),
    ] as const) {
      if (checks.get(id)?.status === "not_checked") {
        setCheck(
          id,
          "not_checked",
          "Skipped because an inspection resource limit was reached.",
        );
      }
    }
  }

  // An in-flight read cannot be interrupted by the cooperative deadline.
  // Preserve completed evidence while disclosing any deadline overrun.
  // This also applies when detection returned an unknown format.
  if (
    performance.now() - startedAt >= maxInspectionTimeMs &&
    !limitations.some(
      (item) => item.code === "time_budget_exhausted",
    )
  ) {
    limitations.push({
      code: "time_budget_exhausted",
      message:
        "Inspection completed its current stage after the time budget elapsed.",
    });
  }

  return finish();
}