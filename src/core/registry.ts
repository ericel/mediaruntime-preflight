import type { FormatInspector } from "../formats/contracts";
import { pngInspector } from "../formats/png";
import type { SupportedFormat } from "../types";

/** Shared by detection, inspection, and policy validation. */
export const formatRegistry: Readonly<Record<SupportedFormat, FormatInspector>> = {
  png: pngInspector,
};
