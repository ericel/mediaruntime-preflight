import { inspectFile } from "../core/inspect-file";

import {
  serializeInspectionError,
} from "./protocol";

import type {
  InspectRequest,
  RequestId,
  WorkerResponse,
} from "./protocol";

/**
 * Minimal worker interface.
 *
 * This avoids adding the entire WebWorker TypeScript library to files
 * that may already use DOM types.
 */
interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;

  postMessage(message: WorkerResponse): void;
}

// This module must only be loaded as a worker entry point.
const scope = globalThis as unknown as WorkerScope;

interface ActiveInspection {
  requestId: RequestId;
  controller: AbortController;
}

let active: ActiveInspection | undefined;

/** Narrow an unknown message to a plain record-like object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/** IDs must be nonempty strings with a reasonable size bound. */
function isRequestId(value: unknown): value is RequestId {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128
  );
}

/**
 * Validate the options crossing the message boundary.
 *
 * The coordinator and reader still enforce numerical ranges and policy
 * semantics. This guard establishes the expected property types.
 */
function isWorkerOptions(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  // Signals must never be sent through this protocol.
  if ("signal" in value) {
    return false;
  }

  if (
    value.stopOnPolicyRejection !== undefined &&
    typeof value.stopOnPolicyRejection !== "boolean"
  ) {
    return false;
  }

  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) {
      return false;
    }

    for (const key of [
      "maxBytesRead",
      "maxInspectionTimeMs",
    ]) {
      const limit = value.limits[key];

      if (limit !== undefined && typeof limit !== "number") {
        return false;
      }
    }
  }

  if (value.policy !== undefined) {
    if (!isRecord(value.policy)) {
      return false;
    }

    for (const key of [
      "maxFileSizeBytes",
      "maxWidth",
      "maxHeight",
      "maxPixels",
    ]) {
      const limit = value.policy[key];

      if (limit !== undefined && typeof limit !== "number") {
        return false;
      }
    }

    const formats = value.policy.allowedFormats;

    if (
      formats !== undefined &&
      (
        !Array.isArray(formats) ||
        !formats.every((format) => typeof format === "string")
      )
    ) {
      return false;
    }
  }

  return true;
}

/** Validate an inspection message before invoking the coordinator. */
function isInspectRequest(value: unknown): value is InspectRequest {
  return (
    isRecord(value) &&
    value.type === "inspect" &&
    isRequestId(value.requestId) &&
    value.file instanceof File &&
    isWorkerOptions(value.options)
  );
}

/** Send an operational or protocol error for a known request ID. */
function sendError(
  requestId: RequestId,
  name: string,
  code: string,
  message: string,
): void {
  scope.postMessage({
    type: "error",
    requestId,
    error: { name, code, message },
  });
}

/**
 * Run one accepted inspection and send exactly one terminal response.
 *
 * Partial inspection reports are successful protocol results.
 * Aborts, invalid configuration, and read failures are error responses.
 */
async function execute(
  request: InspectRequest,
  job: ActiveInspection,
): Promise<void> {
  let response: WorkerResponse;

  try {
    const report = await inspectFile(request.file, {
      ...request.options,

      // This signal was created inside the worker.
      signal: job.controller.signal,
    });

    response = {
      type: "result",
      requestId: request.requestId,
      report,
    };
  } catch (error: unknown) {
    response = {
      type: "error",
      requestId: request.requestId,
      error: serializeInspectionError(error),
    };
  } finally {
    // Release the slot before notifying the client.
    // The client may dispatch its next request after receiving the response.
    if (active === job) {
      active = undefined;
    }
  }

  scope.postMessage(response);
}

scope.addEventListener("message", (event) => {
  const message = event.data;

  // Without a usable ID, a response cannot be correlated safely.
  if (!isRecord(message) || !isRequestId(message.requestId)) {
    return;
  }

  const requestId = message.requestId;

  if (message.type === "cancel") {
    if (active?.requestId === requestId) {
      active.controller.abort();
    }

    // Unknown or already-completed cancellations are harmless.
    // The running job sends its terminal response when it settles.
    return;
  }

  /**
   * Ignore duplicate messages for the active ID.
   *
   * Sending a second response for that ID could cause the client to
   * settle the original request incorrectly.
   */
  if (active?.requestId === requestId) {
    return;
  }

  if (!isInspectRequest(message)) {
    sendError(
      requestId,
      "ProtocolError",
      "INVALID_REQUEST",
      "The worker received an invalid inspection request.",
    );
    return;
  }

  if (active !== undefined) {
    sendError(
      requestId,
      "WorkerBusyError",
      "WORKER_BUSY",
      "The worker is already processing another inspection.",
    );
    return;
  }

  const job: ActiveInspection = {
    requestId,
    controller: new AbortController(),
  };

  // Reserve the worker before asynchronous execution starts.
  active = job;

  void execute(message, job).catch((error: unknown) => {
    /**
     * inspectFile errors are already converted into responses.
     * Reaching here indicates a transport or unexpected handler failure.
     *
     * Throw in a task so the client's worker error handler can detect it,
     * rather than leaving the caller waiting indefinitely.
     */
    setTimeout(() => {
      throw error;
    }, 0);
  });
});