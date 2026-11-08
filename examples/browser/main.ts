import { createPreflight } from "../../src/index";

import type {
  InspectionOptions,
  InspectionReport,
} from "../../src/index";

/**
 * Find a required element and validate its DOM type.
 *
 * The returned reference is non-null and correctly typed,
 * including when used inside callbacks and async functions.
 */
function requireElement<T extends Element>(
  selector: string,
  elementType: { new (): T },
): T {
  const element = document.querySelector(selector);

  if (!(element instanceof elementType)) {
    throw new Error(
      `Required element "${selector}" is missing or has the wrong type.`,
    );
  }

  return element;
}

// Validate the page elements once and retain typed references.
const fileInput = requireElement(
  "#file-input",
  HTMLInputElement,
);

const inspectButton = requireElement(
  "#inspect-button",
  HTMLButtonElement,
);

const cancelButton = requireElement(
  "#cancel-button",
  HTMLButtonElement,
);

const statusElement = requireElement(
  "#status",
  HTMLElement,
);

const summaryElement = requireElement(
  "#summary",
  HTMLElement,
);

const reportElement = requireElement(
  "#report",
  HTMLPreElement,
);

/** Reuse one client across inspections on this page. */
const preflight = createPreflight({
  maxQueueSize: 4,
  workerResponseTimeoutMs: 30_000,
});

let selectedFile: File | undefined;
let currentController: AbortController | undefined;
let selectionVersion = 0;
let inspectionCount = 0;

const inspectionOptions: InspectionOptions = {
  policy: {
    maxFileSizeBytes: 10 * 1024 * 1024,
    allowedFormats: ["png"],
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixels: 16_000_000,
  },
  limits: {
    maxBytesRead: 64 * 1024,
    maxInspectionTimeMs: 100,
  },
  stopOnPolicyRejection: true,
};

/** Display policy compliance separately from check results. */
function displayReport(report: InspectionReport): void {
  const failedChecks = report.checks.filter(
    (check) => check.status === "failed",
  );

  const incompleteChecks = report.coverage.incompleteChecks.length;

  summaryElement.textContent = [
    `Policy: ${report.policy.decision}`,
    `Failed checks: ${failedChecks.length}`,
    `Incomplete checks: ${incompleteChecks}`,
    `Bytes read: ${report.metrics.bytesRead}`,
    `Total: ${report.metrics.totalDurationMs.toFixed(2)} ms`,
    `Inspection: ${report.metrics.inspectionDurationMs.toFixed(2)} ms`,
  ].join(" | ");

  // Render report strings as text, without interpreting them as HTML.
  reportElement.textContent = JSON.stringify(report, null, 2);
}

/** Inspect a file while preventing stale requests from updating the UI. */
async function runInspection(file: File): Promise<void> {
  // Cancel the previous request before starting another inspection.
  currentController?.abort();

  const version = ++selectionVersion;
  const controller = new AbortController();
  currentController = controller;

  const runNumber = ++inspectionCount;

  inspectButton.disabled = true;
  cancelButton.disabled = false;

  statusElement.textContent =
    `Inspecting ${file.name} — run ${runNumber}…`;

  summaryElement.textContent = "Inspection in progress.";
  reportElement.textContent = "{}";

  try {
    const report = await preflight.inspect(file, {
      ...inspectionOptions,
      signal: controller.signal,
    });

    // Another selection may have superseded this request.
    if (version !== selectionVersion) {
      return;
    }

    displayReport(report);

    statusElement.textContent =
      `Finished inspecting ${file.name} — run ${runNumber}.`;
  } catch (error: unknown) {
    // An older request must not overwrite the current request's UI.
    if (version !== selectionVersion) {
      return;
    }

    const cancelled =
      error instanceof Error && error.name === "AbortError";

    statusElement.textContent = cancelled
      ? "Inspection cancelled."
      : "Inspection failed.";

    summaryElement.textContent =
      error instanceof Error
        ? error.message
        : "Unknown inspection error.";

    reportElement.textContent = "{}";
  } finally {
    // Only the current request can reset the controls.
    if (version === selectionVersion) {
      currentController = undefined;
      cancelButton.disabled = true;
      inspectButton.disabled = selectedFile === undefined;
    }
  }
}

// Selecting a file starts an inspection immediately.
fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0];

  if (!selectedFile) {
    currentController?.abort();

    // Invalidate pending UI updates when the selection is cleared.
    selectionVersion += 1;
    currentController = undefined;

    inspectButton.disabled = true;
    cancelButton.disabled = true;
    statusElement.textContent = "Select a file to begin.";
    summaryElement.textContent = "No inspection yet.";
    reportElement.textContent = "{}";
    return;
  }

  void runInspection(selectedFile);
});

// Reinspect the selected file using the same client and worker.
inspectButton.addEventListener("click", () => {
  if (selectedFile) {
    void runInspection(selectedFile);
  }
});

// Request cancellation of the current inspection.
cancelButton.addEventListener("click", () => {
  currentController?.abort();
});

/** Release resources when leaving the page. */
window.addEventListener("pagehide", () => {
  currentController?.abort();
  preflight.dispose();
});

/** Recreate the client if the browser restores this disposed page. */
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});