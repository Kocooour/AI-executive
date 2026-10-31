import { defineConfig, devices } from "@playwright/test";

/**
 * Focused R2c.5b browser regression suite. Unlike the full e2e config, it
 * doesn't start the Next app, prepare credentials, or run authentication setup.
 * Each test intercepts its own localhost HTML document (secure context for IDB).
 */
export default defineConfig({
  testDir: ".",
  testMatch: "target-sync-indexeddb.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
