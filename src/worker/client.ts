import type {
  InspectionOptions,
  InspectionReport,
} from "../types";

import type {
  InspectRequest,
  SerializedInspectionError,
  WorkerInspectionOptions,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

/** Operational errors produced by the worker client itself. */
export class WorkerClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerClientError";
  }
}

/** Reconstruct worker errors without pretending to restore their prototypes. */
export class RemoteInspectionError extends Error {
  readonly code: string | undefined;

  constructor(error: SerializedInspectionError) {
    super(error.message);
    this.name = error.name;
    this.code = error.code;
  }
}

export interface WorkerClientOptions {
  /** Must create a fresh, dedicated worker each time it is called. */
  createWorker: () => Worker;

  /** Waiting requests, excluding the active request. Defaults to 16. */
  maxQueueSize?: number;

  /**
   * Watchdog from dispatch until worker response, including startup.
   * Separate from the coordinator's cooperative inspection budget.
   * Defaults to 30 seconds.
   */
  workerResponseTimeoutMs?: number;
}

export interface InspectionClient {
  inspect(
    file: File,
    options?: InspectionOptions,
  ): Promise<InspectionReport>;

  /** Permanently close this client and reject outstanding requests. */
  dispose(): void;
}

interface PendingInspection {
  request: InspectRequest;
  startedAt: number;
  resolve: (report: InspectionReport) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  detachAbort: () => void;
}

function abortError(): DOMException {
  return new DOMException("File inspection was cancelled.", "AbortError");
}

/** Validate resource limits supplied when constructing the client. */
function validateInteger(
  value: number,
  name: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `${name} must be a safe integer greater than or equal to ${minimum}.`,
    );
  }
}

/**
 * Create a reusable client with one active job and a bounded FIFO queue.
 *
 * Failed workers are discarded. Subsequent inspect() calls can create
 * a fresh worker; failed requests are never retried automatically.
 */
export function createInspectionClient(
  options: WorkerClientOptions,
): InspectionClient {
  const createWorker = options.createWorker;
  const maxQueueSize = options.maxQueueSize ?? 16;
  const timeoutMs = options.workerResponseTimeoutMs ?? 30_000;

  if (typeof createWorker !== "function") {
    throw new TypeError("createWorker must be a function.");
  }

  validateInteger(maxQueueSize, "maxQueueSize", 0);
  validateInteger(timeoutMs, "workerResponseTimeoutMs", 1);

  // Avoid timer overflow in browser setTimeout implementations.
  if (timeoutMs > 2_147_483_647) {
    throw new TypeError("workerResponseTimeoutMs is too large.");
  }

  let worker: Worker | undefined;
  let active: PendingInspection | undefined;
  let disposed = false;
  let nextId = 0;

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let removeWorkerListeners: (() => void) | undefined;

  const queue: PendingInspection[] = [];

  /** Settle a caller exactly once and remove its cancellation listener. */
  function rejectJob(job: PendingInspection, error: unknown): void {
    if (job.settled) return;

    job.settled = true;
    job.detachAbort();
    job.reject(error);
  }

  function resolveJob(
    job: PendingInspection,
    report: InspectionReport,
  ): void {
    if (job.settled) return;

    job.settled = true;
    job.detachAbort();

    // Measure end-to-end latency on the caller's clock.
    job.resolve({
      ...report,
      metrics: {
        ...report.metrics,
        totalDurationMs: performance.now() - job.startedAt,
      },
    });
  }

  function clearWatchdog(): void {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  }

  /** Remove callbacks before terminating so old workers cannot affect us. */
  function destroyWorker(): void {
    clearWatchdog();
    removeWorkerListeners?.();
    removeWorkerListeners = undefined;

    const previous = worker;
    worker = undefined;
    previous?.terminate();
  }

  /** Infrastructure failure invalidates every outstanding request. */
  function failAll(error: unknown): void {
    destroyWorker();

    const current = active;
    active = undefined;

    if (current) {
      rejectJob(current, error);
    }

    for (const job of queue.splice(0)) {
      rejectJob(job, error);
    }
  }

  /** Process responses from our own matching-version worker entry point. */
  function receive(response: WorkerResponse): void {
    const job = active;

    // Ignore stale responses, including duplicates from completed jobs.
    if (!job || response.requestId !== job.request.requestId) {
      return;
    }

    if (response.type !== "result" && response.type !== "error") {
      failAll(
        new WorkerClientError(
          "INVALID_RESPONSE",
          "The worker returned an unexpected response type.",
        ),
      );
      return;
    }

    clearWatchdog();
    active = undefined;

    // Cancelled callers are already settled, but their worker slot
    // stays occupied until this terminal response arrives.
    if (!job.settled) {
      if (response.type === "result") {
        resolveJob(job, response.report);
      } else {
        rejectJob(job, new RemoteInspectionError(response.error));
      }
    }

    dispatch();
  }

  function ensureWorker(): Worker {
    if (worker) return worker;

    const created = createWorker();
    worker = created;

    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      if (worker !== created) return;

      try {
        // This is a private protocol, not a public untrusted report parser.
        // Guard the envelope; report contents come from our own worker.
        const data = event.data;

        if (
          !data ||
          typeof data !== "object" ||
          typeof data.requestId !== "string"
        ) {
          throw new Error("Invalid worker response envelope.");
        }

        receive(data);
      } catch {
        failAll(
          new WorkerClientError(
            "INVALID_RESPONSE",
            "The worker returned an invalid response.",
          ),
        );
      }
    };

    const onError = (event: ErrorEvent): void => {
      if (worker !== created) return;

      event.preventDefault();

      failAll(
        new WorkerClientError(
          "WORKER_FAILED",
          event.message || "The inspection worker failed.",
        ),
      );
    };

    const onMessageError = (): void => {
      if (worker !== created) return;

      failAll(
        new WorkerClientError(
          "MESSAGE_FAILED",
          "A worker message could not be deserialized.",
        ),
      );
    };

    created.addEventListener("message", onMessage);
    created.addEventListener("error", onError);
    created.addEventListener("messageerror", onMessageError);

    removeWorkerListeners = () => {
      created.removeEventListener("message", onMessage);
      created.removeEventListener("error", onError);
      created.removeEventListener("messageerror", onMessageError);
    };

    return created;
  }

  /** Dispatch only when the worker has no active inspection. */
  function dispatch(): void {
    if (disposed || active) return;

    const job = queue.shift();
    if (!job) return;

    active = job;

    try {
      const target = ensureWorker();

      watchdog = setTimeout(() => {
        if (active !== job) return;

        failAll(
          new WorkerClientError(
            "WORKER_TIMEOUT",
            "The inspection worker did not respond within its timeout.",
          ),
        );
      }, timeoutMs);

      target.postMessage(job.request);
    } catch (error: unknown) {
      failAll(
        new WorkerClientError(
          "WORKER_DISPATCH_FAILED",
          error instanceof Error
            ? error.message
            : "Could not start or contact the inspection worker.",
        ),
      );
    }
  }

  function cancel(job: PendingInspection): void {
    if (job.settled) return;

    // Reject the caller immediately.
    rejectJob(job, abortError());

    if (active === job) {
      const target = worker;

      if (!target) {
        failAll(
          new WorkerClientError(
            "WORKER_FAILED",
            "The active inspection has no worker.",
          ),
        );
        return;
      }

      try {
        const message: WorkerRequest = {
          type: "cancel",
          requestId: job.request.requestId,
        };

        target.postMessage(message);

        // Keep the slot and watchdog until a terminal response arrives.
      } catch {
        failAll(
          new WorkerClientError(
            "CANCEL_FAILED",
            "Could not deliver cancellation to the worker.",
          ),
        );
      }
    } else {
      // Queued jobs have not reached the worker and can be removed directly.
      const index = queue.indexOf(job);

      if (index !== -1) {
        queue.splice(index, 1);
      }
    }
  }

  return {
    async inspect(
      file: File,
      inspectionOptions: InspectionOptions = {},
    ): Promise<InspectionReport> {
      const startedAt = performance.now();

      if (disposed) {
        throw new WorkerClientError(
          "CLIENT_DISPOSED",
          "This inspection client has been disposed.",
        );
      }

      const { signal, ...plainOptions } = inspectionOptions;

      if (signal?.aborted) {
        throw abortError();
      }

      if (active && queue.length >= maxQueueSize) {
        throw new WorkerClientError(
          "QUEUE_FULL",
          "The inspection queue is full.",
        );
      }

      // Snapshot before queueing; never clone or send the AbortSignal.
      const workerOptions: WorkerInspectionOptions =
        structuredClone(plainOptions);

      if (nextId >= Number.MAX_SAFE_INTEGER) {
        throw new WorkerClientError(
          "REQUEST_ID_EXHAUSTED",
          "Create a new inspection client to obtain fresh request IDs.",
        );
      }

      const requestId = String(++nextId);

      return new Promise<InspectionReport>((resolve, reject) => {
        const job: PendingInspection = {
          request: {
            type: "inspect",
            requestId,
            file,
            options: workerOptions,
          },
          startedAt,
          resolve,
          reject,
          settled: false,
          detachAbort: () => {},
        };

        if (signal) {
          const onAbort = (): void => cancel(job);

          signal.addEventListener("abort", onAbort, { once: true });
          job.detachAbort = () => {
            signal.removeEventListener("abort", onAbort);
          };

          // Covers cancellation before listener registration completed.
          if (signal.aborted) {
            cancel(job);
            return;
          }
        }

        queue.push(job);
        dispatch();
      });
    },

    dispose(): void {
      if (disposed) return;

      disposed = true;

      failAll(
        new WorkerClientError(
          "CLIENT_DISPOSED",
          "The inspection client was disposed.",
        ),
      );
    },
  };
}