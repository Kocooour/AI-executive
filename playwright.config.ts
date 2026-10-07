import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a production build of this checkout with its own port, data
// directory and throwaway credentials. Nothing here touches a real instance.
const port = Number(process.env.E2E_PORT || 3100);
export const e2ePassword = "browser-tests-only";
// The runner loads this file again in every worker; only the first load prepares the instance.
if (!process.env.E2E_DATA_DIR) {
  // One directory per port, emptied at the start of a run: the last run's traces stay readable
  // and runs do not pile up.
  process.env.E2E_DATA_DIR = path.join(os.tmpdir(), `lumi-e2e-${port}`);
  rmSync(process.env.E2E_DATA_DIR, { recursive: true, force: true });
  mkdirSync(process.env.E2E_DATA_DIR, { recursive: true });
  process.env.E2E_PASSWORD_HASH = execFileSync("node", ["scripts/hash-password.mjs"], { input: `${e2ePassword}\n`, stdio: ["pipe", "pipe", "ignore"] })
    .toString().trim().split("\n").pop();
  process.env.E2E_SESSION_SECRET = randomBytes(48).toString("base64");
}
// A sandbox may ship its own Chromium; elsewhere `pnpm exec playwright install chromium` provides it.
const systemChromium = process.env.E2E_CHROMIUM || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  // One shared instance with real data: the scenarios run in order, one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: path.join(process.env.E2E_DATA_DIR, "results"),
  use: {
    baseURL: `http://localhost:${port}`,
    locale: "cs-CZ",
    timezoneId: "Europe/Prague",
    trace: "retain-on-failure",
    launchOptions: systemChromium ? { executablePath: systemChromium } : {},
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState: path.join(process.env.E2E_DATA_DIR, "session.json") }, dependencies: ["setup"] },
  ],
  webServer: {
    command: `${process.env.E2E_SKIP_BUILD ? "" : "pnpm build && "}pnpm start --port ${port} --hostname 127.0.0.1`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      AI_EXECUTIVE_AUTH_ENABLED: "true",
      AI_EXECUTIVE_PASSWORD_HASH: process.env.E2E_PASSWORD_HASH!,
      AI_EXECUTIVE_SESSION_SECRET: process.env.E2E_SESSION_SECRET!,
      AI_EXECUTIVE_DATA_DIR: path.join(process.env.E2E_DATA_DIR, "data"),
    },
  },
});
