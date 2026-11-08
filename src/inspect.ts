import {
  createInspectionClient,
} from "./worker/client";

import type {
  InspectionClient,
} from "./worker/client";

export interface PreflightOptions {
  /** Maximum waiting inspections, excluding the active one. */
  maxQueueSize?: number;

  /** Watchdog covering worker startup and response time. */
  workerResponseTimeoutMs?: number;
}

/**
 * Create a browser preflight instance.
 *
 * Reuse the instance across file selections.
 * Call dispose() when the owning application component is finished.
 */
export function createPreflight(
  options: PreflightOptions = {},
): InspectionClient {
  return createInspectionClient({
    ...options,

    // Keep this expression inline so Vite can locate and bundle the worker.
    createWorker: () =>
      new Worker(
        new URL("./worker/entry.ts", import.meta.url),
        {
          type: "module",
          name: "mediaruntime-preflight",
        },
      ),
  });
}