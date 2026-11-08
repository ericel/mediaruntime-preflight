/** Public browser API. */
export { createPreflight } from "./inspect";
export type { PreflightOptions } from "./inspect";

/** Public client lifecycle and error types. */
export {
  WorkerClientError,
  RemoteInspectionError,
} from "./worker/client";

export type { InspectionClient } from "./worker/client";

/** Public inspection options and report contracts. */
export type {
  SupportedFormat,
  CheckStatus,
  PolicyDecision,
  FindingSeverity,
  CheckId,
  InspectionPolicy,
  InspectionLimits,
  InspectionOptions,
  FileInfo,
  DetectedFileType,
  FileMetadata,
  CheckResult,
  Finding,
  PolicyRuleId,
  PolicyRuleResult,
  PolicyResult,
  CoverageLimitation,
  InspectionCoverage,
  InspectionMetrics,
  InspectionReport,
} from "./types";