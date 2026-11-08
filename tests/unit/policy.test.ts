import { describe, expect, it } from "vitest";

import {
  evaluatePolicy,
  PolicyConfigurationError,
} from "../../src/core/policy";

import type { PolicyInput } from "../../src/core/policy";
import type { InspectionPolicy } from "../../src/types";

/** Return fresh input for each test so mutations cannot leak between tests. */
function makeInput(): PolicyInput {
  return {
    file: {
      name: "photo.png",
      sizeBytes: 500_000,
      declaredMime: "image/png",
    },
    detected: {
      format: "png",
      mime: "image/png",
    },
    metadata: {
      width: 640,
      height: 480,
    },
  };
}

describe("Policy evaluation", () => {
  it("allows when no rules are configured", () => {
    const result = evaluatePolicy(makeInput());

    expect(result).toEqual({
      decision: "allow",
      rules: [],
    });
  });

  it("allows when every configured rule passes", () => {
    const result = evaluatePolicy(makeInput(), {
      maxFileSizeBytes: 1_000_000,
      allowedFormats: ["png"],
      maxWidth: 1920,
      maxHeight: 1080,
      maxPixels: 2_000_000,
    });

    expect(result.decision).toBe("allow");
    expect(result.rules).toHaveLength(5);
    expect(result.rules.every((rule) => rule.status === "passed")).toBe(true);
  });

  // These are the actual values in makeInput().
  const boundaries = [
    { rule: "maxFileSizeBytes", actual: 500_000 },
    { rule: "maxWidth", actual: 640 },
    { rule: "maxHeight", actual: 480 },
    { rule: "maxPixels", actual: 307_200 },
  ] as const;

  describe.each(boundaries)("$rule boundary", ({ rule, actual }) => {
    it("allows a value exactly equal to the limit", () => {
      const policy: InspectionPolicy = { [rule]: actual };
      const result = evaluatePolicy(makeInput(), policy);

      expect(result.decision).toBe("allow");
      expect(result.rules).toEqual([
        expect.objectContaining({
          rule,
          status: "passed",
        }),
      ]);
    });

    it("rejects a value one above the limit", () => {
      const policy: InspectionPolicy = { [rule]: actual - 1 };
      const result = evaluatePolicy(makeInput(), policy);

      expect(result.decision).toBe("reject");
      expect(result.rules[0]).toMatchObject({
        rule,
        status: "failed",
      });
    });
  });

  it("treats zero as an explicit size limit", () => {
    const input = makeInput();

    expect(
      evaluatePolicy(input, { maxFileSizeBytes: 0 }).decision,
    ).toBe("reject");

    input.file.sizeBytes = 0;

    // This passes only the size rule, not file-integrity checks.
    expect(
      evaluatePolicy(input, { maxFileSizeBytes: 0 }).decision,
    ).toBe("allow");
  });

  it("allows a detected format present in the allowlist", () => {
    const result = evaluatePolicy(makeInput(), {
      allowedFormats: ["png"],
    });

    expect(result.decision).toBe("allow");
    expect(result.rules[0]).toMatchObject({
      rule: "allowedFormats",
      status: "passed",
    });
  });

  it("rejects an explicitly empty format allowlist", () => {
    const result = evaluatePolicy(makeInput(), {
      allowedFormats: [],
    });

    expect(result.decision).toBe("reject");
  });

  it("returns undetermined for an unknown format with an allowlist", () => {
    const input = makeInput();
    input.detected = { format: "unknown", mime: null };

    // The filename and declared MIME still say PNG.
    // They must not substitute for byte-based detection.
    const result = evaluatePolicy(input, {
      allowedFormats: ["png"],
    });

    expect(result.decision).toBe("undetermined");
    expect(result.rules[0]).toMatchObject({
      rule: "allowedFormats",
      status: "undetermined",
    });
  });

  it("does not restrict unknown formats when no format rule exists", () => {
    const input = makeInput();
    input.detected = { format: "unknown", mime: null };

    const result = evaluatePolicy(input, {
      maxFileSizeBytes: 500_000,
    });

    expect(result.decision).toBe("allow");
    expect(result.rules).toHaveLength(1);
  });

  it("returns undetermined when required dimensions are missing", () => {
    const input = makeInput();
    input.metadata = {};

    const result = evaluatePolicy(input, {
      maxWidth: 1920,
      maxHeight: 1080,
      maxPixels: 2_000_000,
    });

    expect(result.decision).toBe("undetermined");
    expect(result.rules).toHaveLength(3);
    expect(
      result.rules.every((rule) => rule.status === "undetermined"),
    ).toBe(true);
  });

  it("evaluates known width while leaving missing height unresolved", () => {
    const input = makeInput();
    input.metadata = { width: 640 };

    const result = evaluatePolicy(input, {
      maxWidth: 640,
      maxHeight: 480,
      maxPixels: 307_200,
    });

    expect(result.decision).toBe("undetermined");
    expect(result.rules).toEqual([
      expect.objectContaining({
        rule: "maxWidth",
        status: "passed",
      }),
      expect.objectContaining({
        rule: "maxHeight",
        status: "undetermined",
      }),
      expect.objectContaining({
        rule: "maxPixels",
        status: "undetermined",
      }),
    ]);
  });

  it("rejects when one rule fails even if another is undetermined", () => {
    const input = makeInput();
    input.metadata = {};

    const result = evaluatePolicy(input, {
      maxFileSizeBytes: 100,
      maxWidth: 1920,
    });

    expect(result.decision).toBe("reject");
    expect(result.rules).toEqual([
      expect.objectContaining({
        rule: "maxFileSizeBytes",
        status: "failed",
      }),
      expect.objectContaining({
        rule: "maxWidth",
        status: "undetermined",
      }),
    ]);
  });

  it("rejects pixel counts beyond the safe integer range", () => {
    const input = makeInput();

    // Each dimension is valid as a PNG dimension.
    // Their product is too large to represent as a safe integer.
    input.metadata = {
      width: 0x7fffffff,
      height: 0x7fffffff,
    };

    const result = evaluatePolicy(input, {
      maxPixels: Number.MAX_SAFE_INTEGER,
    });

    expect(result.decision).toBe("reject");
    expect(result.rules[0]).toMatchObject({
      rule: "maxPixels",
      status: "failed",
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "does not treat invalid width %s as established metadata",
    (width) => {
      const input = makeInput();
      input.metadata.width = width;

      const result = evaluatePolicy(input, {
        maxWidth: 1920,
        maxPixels: 2_000_000,
      });

      expect(result.decision).toBe("undetermined");
      expect(
        result.rules.every((rule) => rule.status === "undetermined"),
      ).toBe(true);
    },
  );

  const numericRules = [
    "maxFileSizeBytes",
    "maxWidth",
    "maxHeight",
    "maxPixels",
  ] as const;

  describe.each(numericRules)("invalid %s configuration", (rule) => {
    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      "throws for limit %s",
      (limit) => {
        const policy: InspectionPolicy = { [rule]: limit };

        expect(() => evaluatePolicy(makeInput(), policy)).toThrow(
          PolicyConfigurationError,
        );
      },
    );
  });

  it("rejects an unsupported configured format at runtime", () => {
    // Deliberately bypass TypeScript to simulate an untyped JS caller.
    const policy = {
      allowedFormats: ["jpeg"],
    } as unknown as InspectionPolicy;

    expect(() => evaluatePolicy(makeInput(), policy)).toThrow(
      PolicyConfigurationError,
    );
  });

  it("rejects a non-array allowlist at runtime", () => {
    // Runtime validation is still needed despite TypeScript declarations.
    const policy = {
      allowedFormats: "png",
    } as unknown as InspectionPolicy;

    expect(() => evaluatePolicy(makeInput(), policy)).toThrow(
      PolicyConfigurationError,
    );
  });
});