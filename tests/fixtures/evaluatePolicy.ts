import { evaluatePolicy } from "../../src/core/policy";

const result = evaluatePolicy(
  {
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
  },
  {
    maxFileSizeBytes: 2 * 1024 * 1024, // 2 MiB.
    allowedFormats: ["png"],
    maxWidth: 1920,
    maxHeight: 1080,
    maxPixels: 2_000_000,
  },
);

console.log(result.decision); // "allow"
console.table(result.rules);  // Five passed rules.