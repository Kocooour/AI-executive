import { execFileSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a production build of this checkout with its own port, data
// directory and throwaway credentials. Nothing here touches the data of a real instance.
const port = Number(process.env.E2E_PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT must be a port number between 1024 and 65535");
export const e2ePassword = "browser-tests-only";

// The runner loads this file again in every worker. Only the first load prepares the run: a
// private directory (owner-only, unpredictable name) and credentials that exist for this run only.
if (!process.env.LUMI_E2E_RUN_DIR) {
  process.env.LUMI_E2E_RUN_DIR = mkdtempSync(path.join(os.tmpdir(), "lumi-e2e-"));
  process.env.LUMI_E2E_PASSWORD_HASH = execFileSync(process.execPath, [path.join(__dirname, "scripts", "hash-password.mjs")], { input: `${e2ePassword}\n` })
    .toString().trim().split("\n").pop();
  process.env.LUMI_E2E_SESSION_SECRET = randomBytes(48).toString("base64");
  // The integration API token of the test instance (listens on loopback only); the data-boundary scenarios present it to
  // endpoints that must refuse it.
  process.env.LUMI_E2E_INTEGRATION_TOKEN = randomBytes(32).toString("hex");
  // Use an unprivileged port below the usual Linux ephemeral-client range (32768–60999).
  // The previous 40000–59999 range could collide with an outgoing socket during the
  // long E2E run, making the CalDAV mock fail before its first test (EADDRINUSE).
  process.env.LUMI_E2E_CALDAV_PORT = String(20_000 + randomInt(10_000));
  process.env.LUMI_E2E_GMAIL_PORT = String(30_000 + randomInt(2_000));
}
const runDir = process.env.LUMI_E2E_RUN_DIR;
const passwordHash = process.env.LUMI_E2E_PASSWORD_HASH;
const sessionSecret = process.env.LUMI_E2E_SESSION_SECRET;
if (!passwordHash?.startsWith("scrypt:") || !sessionSecret) throw new Error("The browser test credentials were not generated; unset LUMI_E2E_RUN_DIR and run again.");
export const sessionFile = path.join(runDir, "session.json");
export const integrationToken = process.env.LUMI_E2E_INTEGRATION_TOKEN || "";
export const caldavMockPort = Number(process.env.LUMI_E2E_CALDAV_PORT);
export const gmailMockPort = Number(process.env.LUMI_E2E_GMAIL_PORT);

// A sandbox may ship its own Chromium; elsewhere `pnpm exec playwright install chromium` provides it.
const systemChromium = process.env.E2E_CHROMIUM || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
// Only a separately selected synthetic browser scenario opts in to this staging preview.
const titleSearchPreviewTest = process.env.LUMI_TITLE_SEARCH_PREVIEW_E2E === "true";
const taskPreviewTest = process.env.LUMI_TASK_PREVIEW_E2E === "true";
const notePreviewTest = process.env.LUMI_NOTE_PREVIEW_E2E === "true";
const indexDetailPreviewTest = process.env.LUMI_INDEX_DETAIL_PREVIEW_E2E === "true";

export default defineConfig({
  testDir: "e2e",
  // One shared instance with real data: the scenarios run in order, one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  globalTeardown: "./e2e/teardown.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    locale: "cs-CZ",
    timezoneId: "Europe/Prague",
    trace: "retain-on-failure",
    launchOptions: systemChromium ? { executablePath: systemChromium } : {},
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState: sessionFile }, dependencies: ["setup"] },
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
      // Never override the shared staging transport used by other focused UI
      // workflows (for example UI-09a). These flags only exist in this server
      // when the UI-09b test explicitly opted in. Default-off means omitted.
      ...(titleSearchPreviewTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_TITLE_SEARCH_CLIENT_PREVIEW_ENABLED: "true",
      } : {}),
      ...(taskPreviewTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_TASK_CLIENT_PREVIEW_ENABLED: "true",
      } : {}),
      // UI-09d has an independent default-off synthetic browser flag.
      ...(notePreviewTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED: "true",
      } : {}),
      ...(indexDetailPreviewTest ? {
        AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED: "true",
      } : {}),
      AI_EXECUTIVE_PASSWORD_HASH: passwordHash,
      AI_EXECUTIVE_SESSION_SECRET: sessionSecret,
      AI_EXECUTIVE_DATA_DIR: path.join(runDir, "data"),
      // Next still reads the checkout's .env files. Whatever could reach a real service from
      // there is switched off for the test instance.
      AI_EXECUTIVE_SECURITY_OUTBOX_DIR: path.join(runDir, "security-outbox"),
      AI_EXECUTIVE_INTEGRATION_TOKEN: integrationToken,
      AI_EXECUTIVE_ALLOWED_ORIGINS: "",
      // Passkeys are tested with a virtual authenticator on the test address only.
      AI_EXECUTIVE_PASSKEY_ORIGINS: `http://localhost:${port}`,
      OPENAI_API_KEY: "",
      HERMES_AI_ENABLED: "false",
      // iCloud calendar requests of the test instance go to the local mock server instead of iCloud. The server honours the
      // address only with both settings and only for an http:// loopback address (lib/caldav.ts, calDavTestOverride).
      AI_EXECUTIVE_E2E: "true",
      AI_EXECUTIVE_E2E_CALDAV_URL: `http://127.0.0.1:${process.env.LUMI_E2E_CALDAV_PORT}/`,
      AI_EXECUTIVE_E2E_GMAIL_URL: `http://127.0.0.1:${process.env.LUMI_E2E_GMAIL_PORT}/`,
      AI_EXECUTIVE_GMAIL_CLIENT_ID: "lumi-e2e-only",
      AI_EXECUTIVE_GMAIL_CLIENT_SECRET: "test-only-not-google",
      AI_EXECUTIVE_GMAIL_REDIRECT_URI: `http://localhost:${port}/api/mail/gmail/callback`,
      AI_EXECUTIVE_MAIL_SECRET: "e2e-only-mail-encryption-key-0123456789",

    },
  },
});
