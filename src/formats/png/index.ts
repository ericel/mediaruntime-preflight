import type { FormatInspector } from "../contracts";
import { pngHeaderCheck } from "./header";
import { pngDetector } from "./signature";

/** PNG currently implements signature detection and IHDR inspection. */
export const pngInspector: FormatInspector = {
  detected: {
    format: "png",
    mime: "image/png",
  },

  // Accepted filename extensions, without a leading dot.
  extensions: ["png"],

  signature: pngDetector,
  checks: [pngHeaderCheck],
};

// Preserve existing exports used by the tests and other modules.
export { inspectPngHeader } from "./header";
export type { PngHeaderResult } from "./header";
export { hasPngSignature } from "./signature";