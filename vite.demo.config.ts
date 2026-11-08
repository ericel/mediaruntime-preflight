import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // The browser example is the application we are building.
  root: fileURLToPath(
    new URL("./examples/browser/", import.meta.url),
  ),

  build: {
    // Keep demo output separate from the SDK's future package build.
    outDir: fileURLToPath(
      new URL("./dist-demo/", import.meta.url),
    ),

    // This directory contains generated demo files only.
    emptyOutDir: true,
  },

  worker: {
    // Bundle the worker as an ES module.
    format: "es",
  },
});