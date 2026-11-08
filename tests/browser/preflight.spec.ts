import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";

import type { InspectionReport } from "../../src/types";

/**
 * Create the 33 bytes needed by our PNG header inspector.
 *
 * This deliberately is NOT a complete PNG:
 * CRC, image data, and IEND are absent or unvalidated.
 * It tests exactly the coverage implemented in this milestone.
 */
function createPngHeader(
  width = 640,
  height = 480,
): Buffer {
  const bytes = Buffer.alloc(33);

  // PNG signature: eight bytes.
  bytes.set([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  // First chunk: IHDR with thirteen bytes of data.
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");

  // Dimensions are unsigned, big-endian integers.
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);

  bytes[24] = 8; // Bit depth.
  bytes[25] = 6; // RGBA color type.
  bytes[26] = 0; // Compression method.
  bytes[27] = 0; // Filter method.
  bytes[28] = 0; // No interlacing.

  // Bytes 29–32 remain zero: CRC is not validated yet.
  return bytes;
}

/** Upload a fixture through the same input used by a person. */
async function selectPng(
  page: Page,
  width = 640,
  height = 480,
): Promise<void> {
  await page.locator("#file-input").setInputFiles({
    name: "header-fixture.png",
    mimeType: "image/png",
    buffer: createPngHeader(width, height),
  });
}

/** Wait for a particular run, then read its displayed report. */
async function readReport(
  page: Page,
  runNumber: number,
): Promise<InspectionReport> {
  await expect(page.locator("#status")).toHaveText(
    `Finished inspecting header-fixture.png — run ${runNumber}.`,
  );

  const text = await page.locator("#report").innerText();

  // Assertions below validate the report fields relevant to each test.
  return JSON.parse(text) as InspectionReport;
}

test("the production worker inspects a PNG header", async ({
  page,
}) => {
  await page.goto("/");
  await selectPng(page);

  const report = await readReport(page, 1);

  expect(report.schemaVersion).toBe("0.1");

  expect(report.detected).toEqual({
    format: "png",
    mime: "image/png",
  });

  expect(report.metadata).toEqual({
    width: 640,
    height: 480,
  });

  expect(report.metrics.bytesRead).toBe(33);
  expect(report.policy.decision).toBe("allow");

  expect(report.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "png.header",
        status: "passed",
      }),
      expect.objectContaining({
        id: "file.integrity",
        status: "not_checked",
      }),
      expect.objectContaining({
        id: "file.malware",
        status: "not_checked",
      }),
    ]),
  );
});

test("Inspect again reuses the existing worker", async ({
  page,
}) => {
  let workersCreated = 0;

  // Observe actual dedicated workers created by the browser.
  page.on("worker", () => {
    workersCreated += 1;
  });

  await page.goto("/");
  await selectPng(page);

  const first = await readReport(page, 1);

  expect(workersCreated).toBe(1);

  await page.locator("#inspect-button").click();

  const second = await readReport(page, 2);

  // A second inspection must not create another worker.
  expect(workersCreated).toBe(1);

  expect(second.detected).toEqual(first.detected);
  expect(second.metadata).toEqual(first.metadata);

  // Read accounting belongs to each inspection independently.
  expect(first.metrics.bytesRead).toBe(33);
  expect(second.metrics.bytesRead).toBe(33);
});

test("the browser reports a dimension policy rejection", async ({
  page,
}) => {
  await page.goto("/");

  // The demo's configured maximum width is 4096.
  await selectPng(page, 4097, 100);

  const report = await readReport(page, 1);

  // A valid header can still violate an application's policy.
  expect(report.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "png.header",
        status: "passed",
      }),
    ]),
  );

  expect(report.policy.decision).toBe("reject");

  expect(report.policy.rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        rule: "maxWidth",
        status: "failed",
      }),
    ]),
  );

  expect(report.metrics.bytesRead).toBe(33);
});