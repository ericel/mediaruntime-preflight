import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createInspectionClient } from "../../src/worker/client";

import type { InspectionReport } from "../../src/types";
import type {
  InspectRequest,
  WorkerRequest,
  WorkerResponse,
} from "../../src/worker/protocol";

/**
 * Controlled worker double.
 *
 * Records outbound requests. Tests explicitly deliver responses,
 * failures, or no response at all.
 */
class FakeWorker extends EventTarget {
  sent: WorkerRequest[] = [];

  postMessage = vi.fn((message: WorkerRequest): void => {
    this.sent.push(message);
  });

  terminate = vi.fn();

  /** Deliver a message as if it came from the worker. */
  reply(response: WorkerResponse): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: response }),
    );
  }

  /** Simulate failure to deserialize a message. */
  fail(): void {
    this.dispatchEvent(new Event("messageerror"));
  }

  /** Return the most recently dispatched inspection request. */
  latestInspection(): InspectRequest {
    const requests = this.sent.filter(
      (message): message is InspectRequest => message.type === "inspect",
    );

    const request = requests[requests.length - 1];

    if (!request) {
      throw new Error("No inspection request was dispatched.");
    }

    return request;
  }
}

/** Minimal complete report for transport tests, not parser tests. */
function makeReport(): InspectionReport {
  return {
    schemaVersion: "0.1",
    file: {
      name: "sample.bin",
      sizeBytes: 1,
      declaredMime: "",
    },
    detected: {
      format: "unknown",
      mime: null,
    },
    metadata: {},
    checks: [],
    findings: [],
    policy: {
      decision: "allow",
      rules: [],
    },
    coverage: {
      completedChecks: [],
      incompleteChecks: [],
      limitations: [],
    },
    metrics: {
      totalDurationMs: 0,
      inspectionDurationMs: 2,
      bytesRead: 1,
    },
  };
}

/** The transport tests do not need a valid PNG. */
function makeFile(): File {
  return new File([new Uint8Array([0])], "sample.bin");
}

function sendResult(worker: FakeWorker): void {
  worker.reply({
    type: "result",
    requestId: worker.latestInspection().requestId,
    report: makeReport(),
  });
}

describe("Worker client", () => {
  const clients: ReturnType<typeof createInspectionClient>[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Ensure no test leaves workers or watchdog timers behind.
    for (const client of clients.splice(0)) {
      client.dispose();
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(maxQueueSize = 16) {
    const workers: FakeWorker[] = [];

    const factory = vi.fn((): Worker => {
      const worker = new FakeWorker();
      workers.push(worker);

      // Only the Worker methods used by the client are implemented.
      return worker as unknown as Worker;
    });

    const client = createInspectionClient({
      createWorker: factory,
      maxQueueSize,
      workerResponseTimeoutMs: 1_000,
    });

    clients.push(client);

    function latestWorker(): FakeWorker {
      const worker = workers[workers.length - 1];

      if (!worker) {
        throw new Error("No worker has been created.");
      }

      return worker;
    }

    return { client, factory, latestWorker };
  }

  it("creates the worker lazily and resolves its report", async () => {
    const { client, factory, latestWorker } = setup();

    expect(factory).not.toHaveBeenCalled();

    const pending = client.inspect(makeFile());
    const worker = latestWorker();

    expect(factory).toHaveBeenCalledTimes(1);

    sendResult(worker);

    const report = await pending;

    expect(report.metrics.bytesRead).toBe(1);
    expect(report.metrics.inspectionDurationMs).toBe(2);
    expect(report.metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses the worker and processes requests in FIFO order", async () => {
    const { client, factory, latestWorker } = setup();

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile());
    const third = client.inspect(makeFile());
    const worker = latestWorker();

    // Only one request may be dispatched at a time.
    expect(worker.sent).toHaveLength(1);
    const firstId = worker.latestInspection().requestId;

    sendResult(worker);
    await first;

    expect(worker.sent).toHaveLength(2);
    const secondId = worker.latestInspection().requestId;

    sendResult(worker);
    await second;

    expect(worker.sent).toHaveLength(3);
    const thirdId = worker.latestInspection().requestId;

    sendResult(worker);
    await third;

    expect(new Set([firstId, secondId, thirdId]).size).toBe(3);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects overflow without counting the active job as queued", async () => {
    const { client, latestWorker } = setup(1);

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile());

    await expect(client.inspect(makeFile())).rejects.toMatchObject({
      code: "QUEUE_FULL",
    });

    const worker = latestWorker();

    sendResult(worker);
    await first;

    sendResult(worker);
    await second;
  });

  it("rejects an already-aborted request without creating a worker", async () => {
    const { client, factory } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.inspect(makeFile(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(factory).not.toHaveBeenCalled();
  });

  it("removes a cancelled queued request without sending it", async () => {
    const { client, latestWorker } = setup();
    const controller = new AbortController();

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile(), {
      signal: controller.signal,
    });

    // Attach the rejection assertion before triggering cancellation.
    const rejected = expect(second).rejects.toMatchObject({
      name: "AbortError",
    });

    controller.abort();
    await rejected;

    const worker = latestWorker();
    expect(worker.sent).toHaveLength(1);

    sendResult(worker);
    await first;

    // The cancelled request never reached the worker.
    expect(worker.sent).toHaveLength(1);
  });

  it("holds the active slot after cancellation until a terminal response", async () => {
    const { client, latestWorker } = setup();
    const controller = new AbortController();

    const first = client.inspect(makeFile(), {
      signal: controller.signal,
    });
    const second = client.inspect(makeFile());

    const worker = latestWorker();
    const firstId = worker.latestInspection().requestId;

    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });

    controller.abort();
    await rejected;

    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toEqual({
      type: "cancel",
      requestId: firstId,
    });

    // A late result still releases the slot, but cannot resolve first again.
    worker.reply({
      type: "result",
      requestId: firstId,
      report: makeReport(),
    });

    expect(worker.sent).toHaveLength(3);
    expect(worker.latestInspection().requestId).not.toBe(firstId);

    sendResult(worker);
    await second;
  });

  it("reconstructs remote error fields and continues the queue", async () => {
    const { client, latestWorker } = setup();

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile());
    const worker = latestWorker();

    const rejected = expect(first).rejects.toMatchObject({
      name: "ReaderError",
      code: "READ_FAILED",
      message: "Could not read the file.",
    });

    worker.reply({
      type: "error",
      requestId: worker.latestInspection().requestId,
      error: {
        name: "ReaderError",
        code: "READ_FAILED",
        message: "Could not read the file.",
      },
    });

    await rejected;

    sendResult(worker);
    await second;

    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("ignores responses that do not match the active request", async () => {
    const { client, latestWorker } = setup();
    const pending = client.inspect(makeFile());
    const worker = latestWorker();

    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    worker.reply({
      type: "result",
      requestId: "unrelated-request",
      report: makeReport(),
    });

    await Promise.resolve();

    expect(settled).toBe(false);

    sendResult(worker);
    await pending;
  });

  it("terminates an unresponsive worker and rejects active and queued jobs", async () => {
    const { client, latestWorker } = setup();

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile());
    const worker = latestWorker();

    const firstRejected = expect(first).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
    });
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([firstRejected, secondRejected]);

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates a fresh worker for a new request after transport failure", async () => {
    const { client, factory, latestWorker } = setup();

    const failed = client.inspect(makeFile());
    const oldWorker = latestWorker();

    const rejected = expect(failed).rejects.toMatchObject({
      code: "MESSAGE_FAILED",
    });

    oldWorker.fail();
    await rejected;

    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);

    const next = client.inspect(makeFile());
    const newWorker = latestWorker();

    expect(newWorker).not.toBe(oldWorker);
    expect(factory).toHaveBeenCalledTimes(2);

    sendResult(newWorker);
    await next;
  });

  it("rejects outstanding and future requests after disposal", async () => {
    const { client, latestWorker } = setup();

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile());
    const worker = latestWorker();

    const firstRejected = expect(first).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });

    client.dispose();
    client.dispose(); // Disposal is idempotent.

    await Promise.all([firstRejected, secondRejected]);

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await expect(client.inspect(makeFile())).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
  });

  it("snapshots queued options and excludes AbortSignal from messages", async () => {
    const { client, latestWorker } = setup();
    const controller = new AbortController();
    const policy = { maxWidth: 640 };

    const first = client.inspect(makeFile());
    const second = client.inspect(makeFile(), {
      policy,
      signal: controller.signal,
    });

    // Mutate the original object while the second request waits.
    policy.maxWidth = 1;

    const worker = latestWorker();
    sendResult(worker);
    await first;

    const dispatched = worker.latestInspection();

    expect(dispatched.options.policy?.maxWidth).toBe(640);
    expect("signal" in dispatched.options).toBe(false);

    sendResult(worker);
    await second;
  });

  it("rejects the request if worker construction fails", async () => {
    const client = createInspectionClient({
      createWorker: () => {
        throw new Error("Worker loading blocked.");
      },
    });

    clients.push(client);

    await expect(client.inspect(makeFile())).rejects.toMatchObject({
      code: "WORKER_DISPATCH_FAILED",
      message: "Worker loading blocked.",
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});