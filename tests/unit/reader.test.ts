import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileReader } from "../../src/core/reader";

/** Eight predictable bytes make range assertions easy to inspect. */
function makeSource(): Blob {
  return new Blob([
    new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bounded file reader", () => {
  it("reads only the requested range and updates accounting", async () => {
    const source = makeSource();
    const sliceSpy = vi.spyOn(source, "slice");
    const reader = createFileReader(source, { maxBytesRead: 8 });

    const bytes = await reader.read(2, 3);

    expect(bytes).toEqual(new Uint8Array([30, 40, 50]));
    expect(sliceSpy).toHaveBeenCalledWith(2, 5);
    expect(reader.sizeBytes).toBe(8);
    expect(reader.bytesRead).toBe(3);
    expect(reader.remainingBudgetBytes).toBe(5);
    expect(reader.activeReads).toBe(0);
  });

  it("counts repeated reads against the total budget", async () => {
    const reader = createFileReader(makeSource(), {
      maxBytesRead: 4,
    });

    await reader.read(0, 2);
    await reader.read(0, 2);

    expect(reader.bytesRead).toBe(4);

    await expect(reader.read(0, 1)).rejects.toMatchObject({
      code: "READ_BUDGET_EXCEEDED",
    });
  });

  it("allows an empty read at EOF without performing I/O", async () => {
    const source = makeSource();
    const sliceSpy = vi.spyOn(source, "slice");
    const reader = createFileReader(source, { maxBytesRead: 0 });

    expect(await reader.read(8, 0)).toEqual(new Uint8Array(0));
    expect(sliceSpy).not.toHaveBeenCalled();
    expect(reader.bytesRead).toBe(0);
  });

  it("rejects a range extending beyond EOF", async () => {
    const reader = createFileReader(makeSource(), {
      maxBytesRead: 100,
    });

    await expect(reader.read(7, 2)).rejects.toMatchObject({
      code: "OUT_OF_BOUNDS",
    });

    expect(reader.bytesRead).toBe(0);
  });

  it.each([
    [-1, 1],
    [0, -1],
    [0.5, 1],
    [0, NaN],
    [Infinity, 1],
  ])("rejects invalid offset %s or length %s", async (offset, length) => {
    const reader = createFileReader(makeSource(), {
      maxBytesRead: 8,
    });

    await expect(reader.read(offset, length)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("enforces the per-read limit independently of total budget", async () => {
    const reader = createFileReader(makeSource(), {
      maxBytesRead: 100,
      maxReadSizeBytes: 2,
    });

    await expect(reader.read(0, 3)).rejects.toMatchObject({
      code: "READ_SIZE_EXCEEDED",
    });

    expect(reader.bytesRead).toBe(0);
  });

  it("rejects excess concurrent reads and releases the slot afterward", async () => {
    const reader = createFileReader(makeSource(), {
      maxBytesRead: 8,
      maxConcurrentReads: 1,
    });

    // The first call reserves its slot before yielding at await.
    const first = reader.read(0, 4);

    expect(reader.activeReads).toBe(1);

    const rejected = expect(reader.read(4, 4)).rejects.toMatchObject({
      code: "CONCURRENT_READ_LIMIT",
    });

    await first;
    await rejected;

    expect(reader.activeReads).toBe(0);

    // The slot becomes available again after completion.
    await reader.read(4, 4);
    expect(reader.bytesRead).toBe(8);
  });

  it("reserves budget before concurrent reads complete", async () => {
    const reader = createFileReader(makeSource(), {
      maxBytesRead: 6,
      maxConcurrentReads: 2,
    });

    const first = reader.read(0, 4);

    expect(reader.remainingBudgetBytes).toBe(2);

    const rejected = expect(reader.read(4, 4)).rejects.toMatchObject({
      code: "READ_BUDGET_EXCEEDED",
    });

    await first;
    await rejected;

    expect(reader.bytesRead).toBe(4);
    expect(reader.remainingBudgetBytes).toBe(2);
  });

  it("releases reservations after an I/O failure", async () => {
    const source = makeSource();
    const part = new Blob();

    vi.spyOn(part, "arrayBuffer").mockRejectedValue(
      new Error("Simulated read failure"),
    );
    vi.spyOn(source, "slice").mockReturnValue(part);

    const reader = createFileReader(source, { maxBytesRead: 8 });

    await expect(reader.read(0, 4)).rejects.toMatchObject({
      code: "READ_FAILED",
    });

    expect(reader.bytesRead).toBe(0);
    expect(reader.remainingBudgetBytes).toBe(8);
    expect(reader.activeReads).toBe(0);
  });

  it("rejects an already-aborted read without performing I/O", async () => {
    const source = makeSource();
    const sliceSpy = vi.spyOn(source, "slice");
    const controller = new AbortController();
    controller.abort();

    const reader = createFileReader(source, {
      maxBytesRead: 8,
      signal: controller.signal,
    });

    await expect(reader.read(0, 4)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(sliceSpy).not.toHaveBeenCalled();
    expect(reader.activeReads).toBe(0);
  });

  it("counts completed I/O even when cancelled during the read", async () => {
    const source = makeSource();
    const controller = new AbortController();
    const part = new Blob();

    vi.spyOn(part, "arrayBuffer").mockImplementation(async () => {
      controller.abort();
      return new ArrayBuffer(4);
    });
    vi.spyOn(source, "slice").mockReturnValue(part);

    const reader = createFileReader(source, {
      maxBytesRead: 8,
      signal: controller.signal,
    });

    await expect(reader.read(0, 4)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(reader.bytesRead).toBe(4);
    expect(reader.remainingBudgetBytes).toBe(4);
    expect(reader.activeReads).toBe(0);
  });

  it("rejects an unexpected short read and accounts for returned bytes", async () => {
    const source = makeSource();
    const part = new Blob();

    vi.spyOn(part, "arrayBuffer").mockResolvedValue(new ArrayBuffer(2));
    vi.spyOn(source, "slice").mockReturnValue(part);

    const reader = createFileReader(source, { maxBytesRead: 8 });

    await expect(reader.read(0, 4)).rejects.toMatchObject({
      code: "READ_FAILED",
    });

    expect(reader.bytesRead).toBe(2);
    expect(reader.remainingBudgetBytes).toBe(6);
    expect(reader.activeReads).toBe(0);
  });

  it("captures configuration rather than retaining mutable options", async () => {
    const options = {
      maxBytesRead: 4,
      maxReadSizeBytes: 4,
      maxConcurrentReads: 1,
    };

    const reader = createFileReader(makeSource(), options);
    options.maxBytesRead = 100;

    await reader.read(0, 4);

    await expect(reader.read(4, 1)).rejects.toMatchObject({
      code: "READ_BUDGET_EXCEEDED",
    });
  });
});