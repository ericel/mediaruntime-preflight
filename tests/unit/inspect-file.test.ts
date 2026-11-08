import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { inspectFile } from "../../src/core/inspect-file";
import { PolicyConfigurationError } from "../../src/core/policy";

import type {
  CheckId,
  InspectionOptions,
  InspectionReport,
} from "../../src/types";

/**
 * A header-only fixture.
 *
 * CRC is not calculated, and image-data chunks are absent.
 * This fixture can pass header checks, not full-file validation.
 */
function makeHeader(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);

  bytes.set([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);

  view.setUint32(16, 640, false);
  view.setUint32(20, 480, false);

  bytes[24] = 8;
  bytes[25] = 6;
  bytes[26] = 0;
  bytes[27] = 0;
  bytes[28] = 0;

  return bytes;
}

/** Create an actual File rather than mocking the complete file API. */
function makeFile(
  bytes = makeHeader(),
  name = "photo.png",
  type = "image/png",
): File {
  return new File([bytes], name, { type });
}

/** Fail clearly if the coordinator accidentally omits a check. */
function getCheck(report: InspectionReport, id: CheckId) {
  const check = report.checks.find((item) => item.id === id);

  if (!check) {
    throw new Error(`Report is missing check "${id}".`);
  }

  return check;
}

describe("Inspection coordinator", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;

    // Control the deadline deterministically; no sleeping is needed.
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("combines detection, metadata, checks, and policy into one report", async () => {
    const report = await inspectFile(makeFile(), {
      policy: {
        maxFileSizeBytes: 100,
        allowedFormats: ["png"],
        maxWidth: 640,
        maxHeight: 480,
        maxPixels: 307_200,
      },
    });

    expect(report.schemaVersion).toBe("0.1");

    expect(report.file).toEqual({
      name: "photo.png",
      sizeBytes: 33,
      declaredMime: "image/png",
    });

    expect(report.detected).toEqual({
      format: "png",
      mime: "image/png",
    });

    expect(report.metadata).toEqual({
      width: 640,
      height: 480,
    });

    expect(report.policy.decision).toBe("allow");
    expect(report.policy.rules).toHaveLength(5);
    expect(report.findings).toEqual([]);
    expect(report.metrics.bytesRead).toBe(33);

    for (const id of [
      "file.size",
      "format.signature",
      "format.declared_mime",
      "format.extension",
      "png.header",
    ] as const) {
      expect(getCheck(report, id).status).toBe("passed");
    }

    // Header inspection must not imply these checks were performed.
    expect(getCheck(report, "file.integrity").status).toBe("not_checked");
    expect(getCheck(report, "file.malware").status).toBe("not_checked");
  });

  it("keeps the size check consistent with its policy rule", async () => {
    const report = await inspectFile(makeFile(), {
      policy: { maxFileSizeBytes: 32 },
    });

    const sizeRule = report.policy.rules.find(
      (rule) => rule.rule === "maxFileSizeBytes",
    );

    expect(sizeRule?.status).toBe("failed");
    expect(getCheck(report, "file.size").status).toBe(sizeRule?.status);
    expect(report.policy.decision).toBe("reject");
  });

  it("rejects oversized files before any content read when requested", async () => {
    const file = makeFile();
    const sliceSpy = vi.spyOn(file, "slice");

    const report = await inspectFile(file, {
      policy: { maxFileSizeBytes: 32 },
      stopOnPolicyRejection: true,
    });

    expect(report.policy.decision).toBe("reject");
    expect(report.metrics.bytesRead).toBe(0);
    expect(sliceSpy).not.toHaveBeenCalled();

    expect(getCheck(report, "format.signature").status).toBe("not_checked");
    expect(getCheck(report, "png.header").status).toBe("not_checked");

    expect(report.coverage.limitations).toContainEqual(
      expect.objectContaining({
        code: "early_policy_rejection",
      }),
    );
  });

  it("continues inspection after policy rejection by default", async () => {
    const report = await inspectFile(makeFile(), {
      policy: { maxFileSizeBytes: 32 },
    });

    expect(report.policy.decision).toBe("reject");
    expect(report.metrics.bytesRead).toBe(33);
    expect(getCheck(report, "png.header").status).toBe("passed");
  });

  it("rejects an empty allowlist without reading content", async () => {
    const report = await inspectFile(makeFile(), {
      policy: { allowedFormats: [] },
      stopOnPolicyRejection: true,
    });

    expect(report.policy.decision).toBe("reject");
    expect(report.metrics.bytesRead).toBe(0);
  });

  it("preserves detected PNG when the header read exceeds the budget", async () => {
    const report = await inspectFile(makeFile(), {
      limits: { maxBytesRead: 8 },
      policy: {
        allowedFormats: ["png"],
        maxWidth: 1920,
      },
    });

    expect(report.detected.format).toBe("png");
    expect(report.metadata).toEqual({});
    expect(report.metrics.bytesRead).toBe(8);

    expect(getCheck(report, "format.signature").status).toBe("passed");
    expect(getCheck(report, "png.header").status).toBe("inconclusive");
    expect(report.policy.decision).toBe("undetermined");

    expect(report.coverage.limitations).toContainEqual(
      expect.objectContaining({
        code: "byte_budget_exhausted",
        checkId: "png.header",
      }),
    );
  });

  it("returns partial coverage when the signature cannot fit the budget", async () => {
    const report = await inspectFile(makeFile(), {
      limits: { maxBytesRead: 7 },
      policy: { allowedFormats: ["png"] },
    });

    expect(report.detected.format).toBe("unknown");
    expect(report.metrics.bytesRead).toBe(0);
    expect(report.policy.decision).toBe("undetermined");

    expect(getCheck(report, "format.signature").status).toBe("inconclusive");
    expect(getCheck(report, "png.header").status).toBe("not_checked");
  });

  it("does not trust a PNG filename or MIME when bytes do not match", async () => {
    const file = makeFile(new Uint8Array(33));

    const report = await inspectFile(file, {
      policy: { allowedFormats: ["png"] },
    });

    expect(report.detected.format).toBe("unknown");
    expect(report.policy.decision).toBe("undetermined");
    expect(report.metrics.bytesRead).toBe(8);

    expect(getCheck(report, "format.signature").status).toBe("inconclusive");
    expect(getCheck(report, "png.header").status).toBe("not_checked");
  });

  it("handles an empty file without claiming a supported format", async () => {
    const report = await inspectFile(makeFile(new Uint8Array(0)), {
      policy: { allowedFormats: ["png"] },
    });

    expect(report.file.sizeBytes).toBe(0);
    expect(report.metrics.bytesRead).toBe(0);
    expect(report.detected.format).toBe("unknown");
    expect(report.policy.decision).toBe("undetermined");
  });

  it("reports declaration mismatches separately from upload policy", async () => {
    const report = await inspectFile(
      makeFile(makeHeader(), "photo.jpg", "image/jpeg"),
      { policy: { allowedFormats: ["png"] } },
    );

    expect(report.detected.format).toBe("png");
    expect(getCheck(report, "format.declared_mime").status).toBe("failed");
    expect(getCheck(report, "format.extension").status).toBe("failed");

    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "DECLARED_MIME_MISMATCH",
        "FILE_EXTENSION_MISMATCH",
      ]),
    );

    // Current policy restricts detected format, not declaration consistency.
    expect(report.policy.decision).toBe("allow");
  });

  it("marks absent MIME and extension comparisons as not checked", async () => {
    const report = await inspectFile(
      makeFile(makeHeader(), "photo", ""),
    );

    expect(getCheck(report, "format.declared_mime").status).toBe("not_checked");
    expect(getCheck(report, "format.extension").status).toBe("not_checked");
    expect(getCheck(report, "png.header").status).toBe("passed");
  });

  it("returns malformed-header findings without inventing dimensions", async () => {
    const bytes = makeHeader();
    new DataView(bytes.buffer).setUint32(16, 0, false);

    const report = await inspectFile(makeFile(bytes), {
      policy: { maxWidth: 1920 },
    });

    expect(getCheck(report, "png.header").status).toBe("failed");
    expect(report.metadata).toEqual({});
    expect(report.policy.decision).toBe("undetermined");

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "PNG_WIDTH_INVALID",
      }),
    );
  });

  it("rejects an already-cancelled request before reading", async () => {
    const controller = new AbortController();
    controller.abort();

    const file = makeFile();
    const sliceSpy = vi.spyOn(file, "slice");

    await expect(
      inspectFile(file, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(sliceSpy).not.toHaveBeenCalled();
  });

  it("propagates cancellation during a file read", async () => {
    const controller = new AbortController();
    const file = makeFile();
    const originalSlice = file.slice.bind(file);

    vi.spyOn(file, "slice").mockImplementation((start, end, type) => {
      const part = originalSlice(start, end, type);
      const originalRead = part.arrayBuffer.bind(part);

      vi.spyOn(part, "arrayBuffer").mockImplementation(async () => {
        const buffer = await originalRead();
        controller.abort();
        return buffer;
      });

      return part;
    });

    await expect(
      inspectFile(file, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates file-read failure instead of returning a partial success", async () => {
    const file = makeFile();
    const part = new Blob();

    vi.spyOn(part, "arrayBuffer").mockRejectedValue(
      new Error("Simulated file-access failure"),
    );
    vi.spyOn(file, "slice").mockReturnValue(part);

    await expect(inspectFile(file)).rejects.toMatchObject({
      name: "ReaderError",
      code: "READ_FAILED",
    });
  });

  it("validates policy before reading, even when early rejection is enabled", async () => {
    const file = makeFile();
    const sliceSpy = vi.spyOn(file, "slice");

    await expect(
      inspectFile(file, {
        policy: {
          maxFileSizeBytes: 0,
          maxWidth: -1,
        },
        stopOnPolicyRejection: true,
      }),
    ).rejects.toBeInstanceOf(PolicyConfigurationError);

    expect(sliceSpy).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity])(
    "rejects invalid time budget %s",
    async (maxInspectionTimeMs) => {
      await expect(
        inspectFile(makeFile(), {
          limits: { maxInspectionTimeMs },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("returns partial coverage immediately with a zero time budget", async () => {
    const report = await inspectFile(makeFile(), {
      limits: { maxInspectionTimeMs: 0 },
      policy: { allowedFormats: ["png"] },
    });

    expect(report.metrics.bytesRead).toBe(0);
    expect(report.policy.decision).toBe("undetermined");
    expect(getCheck(report, "format.signature").status).toBe("inconclusive");

    expect(report.coverage.limitations).toContainEqual(
      expect.objectContaining({
        code: "time_budget_exhausted",
        checkId: "format.signature",
      }),
    );
  });

  it("preserves detection when the deadline expires before header inspection", async () => {
    const file = makeFile();
    const originalSlice = file.slice.bind(file);

    vi.spyOn(file, "slice").mockImplementation((start, end, type) => {
      const part = originalSlice(start, end, type);
      const originalRead = part.arrayBuffer.bind(part);

      vi.spyOn(part, "arrayBuffer").mockImplementation(async () => {
        const buffer = await originalRead();

        // Simulate the signature read completing after the deadline.
        now = 101;
        return buffer;
      });

      return part;
    });

    const report = await inspectFile(file, {
      limits: { maxInspectionTimeMs: 100 },
    });

    expect(report.detected.format).toBe("png");
    expect(report.metrics.bytesRead).toBe(8);
    expect(getCheck(report, "format.signature").status).toBe("passed");
    expect(getCheck(report, "png.header").status).toBe("inconclusive");
  });

  it("preserves a completed header result while disclosing deadline overrun", async () => {
    const file = makeFile();
    const originalSlice = file.slice.bind(file);

    vi.spyOn(file, "slice").mockImplementation((start, end, type) => {
      const part = originalSlice(start, end, type);
      const originalRead = part.arrayBuffer.bind(part);

      vi.spyOn(part, "arrayBuffer").mockImplementation(async () => {
        const buffer = await originalRead();

        // Only the second read, for IHDR, exceeds the deadline.
        if (start === 8) {
          now = 101;
        }

        return buffer;
      });

      return part;
    });

    const report = await inspectFile(file, {
      limits: { maxInspectionTimeMs: 100 },
    });

    expect(getCheck(report, "png.header").status).toBe("passed");
    expect(report.metadata).toEqual({ width: 640, height: 480 });
    expect(report.metrics.bytesRead).toBe(33);

    expect(report.coverage.limitations).toContainEqual(
      expect.objectContaining({ code: "time_budget_exhausted" }),
    );
  });

  it("snapshots policy before asynchronous inspection begins", async () => {
    const options: InspectionOptions = {
      policy: { maxWidth: 640 },
    };

    // inspectFile captures configuration before its first await.
    const pending = inspectFile(makeFile(), options);

    options.policy = { maxWidth: 1 };

    const report = await pending;

    expect(report.policy.decision).toBe("allow");
  });

  it("partitions every check into completed or incomplete coverage", async () => {
    const report = await inspectFile(makeFile());
    const completed = new Set(report.coverage.completedChecks);
    const incomplete = new Set(report.coverage.incompleteChecks);

    expect(new Set(report.checks.map((check) => check.id)).size).toBe(
      report.checks.length,
    );

    for (const check of report.checks) {
      const isComplete =
        check.status === "passed" || check.status === "failed";

      expect(completed.has(check.id)).toBe(isComplete);
      expect(incomplete.has(check.id)).toBe(!isComplete);
    }

    expect(completed.size + incomplete.size).toBe(report.checks.length);
  });
});