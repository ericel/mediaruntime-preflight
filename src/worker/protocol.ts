import type {
  InspectionOptions,
  InspectionReport,
} from "../types";

/**
 * Options sent to the worker.
 *
 * The caller's AbortSignal stays on the main thread.
 * Cancellation is communicated using a separate message.
 */
export type WorkerInspectionOptions = Omit<
  InspectionOptions,
  "signal"
>;

/** Identifies one inspection throughout its lifecycle. */
export type RequestId = string;

/** Ask the worker to inspect a file. */
export interface InspectRequest {
  type: "inspect";
  requestId: RequestId;
  file: File;
  options: WorkerInspectionOptions;
}

/** Ask the worker to cancel an inspection. */
export interface CancelRequest {
  type: "cancel";
  requestId: RequestId;
}

/** All messages the client may send to the worker. */
export type WorkerRequest =
  | InspectRequest
  | CancelRequest;

/**
 * Plain error data sent across the worker boundary.
 *
 * Custom Error prototypes and properties should not be relied on
 * to survive message serialization. Send the fields explicitly.
 */
export interface SerializedInspectionError {
  /** Examples: ReaderError, PolicyConfigurationError, AbortError. */
  name: string;

  /** Human-readable explanation. */
  message: string;

  /** Optional machine-readable code, such as READ_FAILED. */
  code?: string;
}

/** A completed inspection, including reports with partial coverage. */
export interface InspectionResultResponse {
  type: "result";
  requestId: RequestId;
  report: InspectionReport;
}

/** An operational failure or cancellation. */
export interface InspectionErrorResponse {
  type: "error";
  requestId: RequestId;
  error: SerializedInspectionError;
}

/** All messages the worker may send to the client. */
export type WorkerResponse =
  | InspectionResultResponse
  | InspectionErrorResponse;

/**
 * Convert a thrown value into plain message-safe error data.
 *
 * Deliberately omit stack traces and nested originalError objects.
 */
export function serializeInspectionError(
  error: unknown,
): SerializedInspectionError {
  if (error instanceof Error) {
    const serialized: SerializedInspectionError = {
      name: error.name,
      message: error.message,
    };

    // ReaderError exposes a code, but ordinary Error does not.
    if ("code" in error && typeof error.code === "string") {
      serialized.code = error.code;
    }

    return serialized;
  }

  // JavaScript permits throwing strings or other non-Error values.
  return {
    name: "Error",
    message:
      typeof error === "string"
        ? error
        : "Inspection failed with an unknown error.",
  };
}