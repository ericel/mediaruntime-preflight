import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // Keep browser tests separate from Vitest unit tests.
  testDir: "./tests/browser",

  fullyParallel: true,

  use: {
    baseURL: "http://127.0.0.1:4173",

    // Save debugging information when a test fails.
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],

  webServer: {
    // Build first so these tests exercise generated production assets.
    command:
      "npx vite build --config vite.demo.config.ts && " +
      "npx vite preview --config vite.demo.config.ts " +
      "--host 127.0.0.1 --port 4173 --strictPort",

    url: "http://127.0.0.1:4173",

    // Never accidentally test an unrelated running development server.
    reuseExistingServer: false,

    timeout: 120_000,
  },
});