import { execFileSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { targetPersonalV1Env } from "./lib/target-personal-profile";

// Browser tests run against a production build of this checkout with its own port, data
// directory and throwaway credentials. Nothing here touches the data of a real instance.
const port = Number(process.env.E2E_PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT must be a port number between 1024 and 65535");
export const e2ePassword = "browser-tests-only";

// The runner loads this file again in every worker. Only the first load prepares the run: a
// private directory (owner-only, unpredictable name) and credentials that exist for this run only.
const personalOwnerUserId = "e2e-owner";
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
  // Explicit provisioning for this NEW, throwaway browser-test data directory.
  // Never initialize missing production state or replace an existing cutoff.
  execFileSync(process.execPath, [
    "--experimental-loader",
    path.join(__dirname, "scripts", "target-staging-ts-loader.mjs"),
    path.join(__dirname, "scripts", "owner-session-revocation-init.mjs"),
    "--init",
  ], {
    cwd: __dirname,
    env: {
      ...process.env,
      AI_EXECUTIVE_DATA_DIR: path.join(process.env.LUMI_E2E_RUN_DIR, "data"),
    },
  });
  // Opt-in personal acceptance: a REAL isolated target SQLite store inside the run dir (never a legacy or
  // production path), created once per run; workers inherit the settings through the environment.
  if (process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E === "true") {
    process.env.LUMI_E2E_TARGET_STORE = execFileSync(process.execPath, [
      "--experimental-loader", path.join(__dirname, "scripts", "target-staging-ts-loader.mjs"),
      path.join(__dirname, "e2e", "target-personal-store-setup.mjs"), process.env.LUMI_E2E_RUN_DIR, personalOwnerUserId, "1",
    ], { cwd: __dirname, stdio: ["ignore", "pipe", "inherit"] }).toString().trim().split("\n").pop() || "";
  }
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
const targetDetailEditRaceTest = process.env.LUMI_TARGET_DETAIL_EDITS_E2E === "true";
const focusFallbackTest = process.env.LUMI_TARGET_DETAIL_FOCUS_E2E === "true";
const noteEditRecoveryTest = process.env.LUMI_TARGET_NOTE_EDIT_E2E === "true";
const projectTitleRecoveryTest = process.env.LUMI_TARGET_PROJECT_TITLE_E2E === "true";
// R3-FE-05: isolated real-React main Search acceptance. Two CI matrix jobs
// exercise opt-in authorized Search and identical flag-off legacy Search.
const mainTitleSearchTest = process.env.LUMI_TARGET_MAIN_SEARCH_E2E === "true";
const mainTitleSearchMode = process.env.LUMI_TARGET_MAIN_SEARCH_MODE ?? "on";
if(mainTitleSearchTest&&!["on","off"].includes(mainTitleSearchMode))
  throw new Error("Invalid LUMI_TARGET_MAIN_SEARCH_MODE");
// Profile-specific recovery QA (including BOTH active edit flags), isolated to Playwright.
const noteEditProfile = process.env.LUMI_TARGET_NOTE_EDIT_PROFILE ?? "legacy";
if(noteEditRecoveryTest&&!["legacy","combined","4b"].includes(noteEditProfile))
  throw new Error("Invalid LUMI_TARGET_NOTE_EDIT_PROFILE");
const privateNoteAreasTest = process.env.LUMI_PRIVATE_NOTE_AREAS_E2E === "true";
const privateNoteCreateTest = process.env.LUMI_PRIVATE_NOTE_CREATE_E2E === "true";
const privateTaskCreateTest = process.env.LUMI_PRIVATE_TASK_CREATE_E2E === "true";
const globalCaptureTest = process.env.LUMI_TARGET_GLOBAL_CAPTURE_E2E === "true";
// Single end-to-end acceptance: browser -> real route handlers -> real isolated target SQLite, every personal flag on.
const personalAcceptanceTest = process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E === "true";
// Workers legitimately inherit LUMI_E2E_RUN_DIR and LUMI_E2E_TARGET_STORE from the first load; a caller-supplied pair is
// still validated: the store must be exactly <run dir>/target-store with a UUID restore generation and the fixed owner.
const personalStore = personalAcceptanceTest ? (() => {
  const value = JSON.parse(process.env.LUMI_E2E_TARGET_STORE || "null") as { directory?: unknown; restoreGeneration?: unknown; ownerUserId?: unknown } | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!value || typeof value.directory !== "string" || typeof value.restoreGeneration !== "string" || value.ownerUserId !== personalOwnerUserId
    || !uuid.test(value.restoreGeneration) || !existsSync(value.directory)
    || realpathSync(value.directory) !== path.join(realpathSync(runDir), "target-store")) {
    throw new Error("The personal acceptance target store is missing or invalid; unset LUMI_E2E_RUN_DIR and LUMI_E2E_TARGET_STORE and run again.");
  }
  return value as { directory: string; restoreGeneration: string; ownerUserId: string };
})() : null;

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
    // The webServer env below is run-wide: real-store opt-in must only run
    // these four isolated acceptance specs, never other tests.
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState: sessionFile }, dependencies: ["setup"],
      ...(personalAcceptanceTest ? { testMatch: /target-personal-(?:acceptance|my-plan|search-open|bfcache)\.spec\.ts/ } : {}) },
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
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED: "true",
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
      ...(focusFallbackTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED: "true",
      } : {}),
      // Opt-in targeted real-React note editor recovery check with mocked
      // server responses. No staging DB or production note is read/written.
      ...(noteEditRecoveryTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
        ...(noteEditProfile==="4b" ? {} : {AI_EXECUTIVE_TARGET_UI_NOTE_EDIT_ENABLED: "true"}),
        ...(noteEditProfile==="legacy" ? {} : {AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED: "true"}),
      } : {}),
      // Only the synthetic isolated Playwright instance exposes the read-only
      // actor-private Quick Capture chooser; never the host production app.
      ...(privateNoteAreasTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_AREAS_ENABLED: "true",
      } : {}),
      // Focused React detail edit race suite; all target API responses are
      // intercepted by Playwright before they can reach the isolated server.
      ...(targetDetailEditRaceTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED: "true",
      } : {}),
      // R3-FE-05 browser-only, synthetic target session/title pages. For the
      // off job disable ONLY the new UI search flag; the rest of the environment
      // remains identical, proving the legacy Search fallback survives.
      ...(mainTitleSearchTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_TITLE_SEARCH_ENABLED:
          mainTitleSearchMode==="on"?"true":"false",
      } : {}),
      // R3-CAPTURE-2: separate, isolated synthetic CREATE browser run.
      // It NEVER turns on a live host and does not alter read-only chooser CI.
      ...(privateNoteCreateTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_AREAS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_CREATE_ENABLED: "true",
      } : {}),
      // R3-FE-6: only the isolated synthetic private TASK create browser run
      // enables its full read/detail/write flag matrix. No production activation.
      ...(privateTaskCreateTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_AREAS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_CREATE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED: "true",
        // Combined isolated Search + task Capture browser acceptance.
        AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_TITLE_SEARCH_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED: "true",
      } : {}),
      // Explicit opt-in project title reauthentication on a throwaway server.
      // Browser routes are synthetic; no staging DB or production writes.
      ...(projectTitleRecoveryTest ? {
        AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PROJECT_EDIT_ENABLED: "true",
        AI_EXECUTIVE_TARGET_UI_PROJECT_REAUTH_RECOVERY_ENABLED: "true",
      } : {}),
      // Only this synthetic R3-CAPTURE-3 run enables a target detail as an
      // actual modal, to exercise the focus-trapped inspector capture entry.
      ...(globalCaptureTest ? {
        AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED: "true",
      } : {}),
      ...(personalStore ? {
        ...targetPersonalV1Env(),
        AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: personalStore.directory,
        AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: personalStore.restoreGeneration,
        AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: personalStore.ownerUserId,
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
