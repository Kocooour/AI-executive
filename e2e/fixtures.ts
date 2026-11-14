import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { sessionFile } from "../playwright.config";
import { signIn } from "./helpers";

// Every scenario fails when a page it opened throws an uncaught error or leaves a promise
// rejection unhandled, even if all its steps passed: the user would have met an error nobody saw.
// The browser reports these to the test directly, so nothing depends on the app's own report
// reaching the server in time. It covers the default page and every context a scenario opens.
// The server limits requests per client and 10 minutes (lib/http-security.ts), keyed by the
// forwarding address its proxy sets. All scenarios together make more requests than one user
// would, so each scenario is its own client: otherwise the last ones of a run meet the limit
// (the attention list "not available", a missing server copy) and fail at random.
function clientAddress(testId: string) {
  let hash = 0;
  for (const character of testId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `10.${(hash >>> 16) & 255}.${(hash >>> 8) & 255}.${(hash & 255) || 1}`;
}

// Logout revokes every owner cookie, including the one recorded by auth.setup.
// Refresh only the synthetic session cookie for the NEXT test; never persist app
// localStorage or IndexedDB, and never weaken the real server-side revocation.
export async function persistOwnerSession(context: BrowserContext) {
  const { cookies } = await context.storageState();
  if (!cookies.some((cookie) => cookie.name === "ai_executive_session")) {
    throw new Error("Cannot persist a browser test session without an owner cookie");
  }
  const temporary = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
    renameSync(temporary, sessionFile);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function ensureOwnerSession(browser: Browser, baseURL: string, testId: string) {
  // Use a separate, disposable context. A test that deliberately invalidates
  // its own credentials must still be able to finish with a genuine 401.
  const context = await browser.newContext({
    storageState: sessionFile,
    locale: "cs-CZ",
    extraHTTPHeaders: { "x-forwarded-for": clientAddress(testId) },
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/api/auth/status`);
    if (!response || !response.ok()) throw new Error("Cannot validate browser test owner session");
    const status = await response.json() as { enabled: boolean; configured: boolean; authenticated: boolean };
    if (!status.enabled || !status.configured) throw new Error("Browser test authentication is not configured");
    if (status.authenticated) return;

    // The stale cookie really is rejected before we replace it. Do not mask a
    // server outage or unexpected error by blindly logging in again.
    const refused = await page.goto(`${baseURL}/api/store`);
    if (refused?.status() !== 401) {
      throw new Error(`Expected revoked owner session to return 401, got ${refused?.status() ?? "no response"}`);
    }
    await page.goto(baseURL);
    await signIn(page);
    const verified = await page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((reply) => reply.status));
    if (verified !== 200) throw new Error(`Renewed browser test session failed server verification: ${verified}`);
    await persistOwnerSession(context);
  } finally {
    await context.close();
  }
}

export const test = base.extend<{ pageErrors: void; ownerSession: void }>({
  // The shared test instance is serial. With concurrent workers, a real
  // logout in one test can invalidate another worker's in-flight requests;
  // refusing that mode is safer than racing to rewrite one sessionFile.
  ownerSession: [async ({ browser, baseURL }, use, testInfo) => {
    if (testInfo.config.workers !== 1) {
      throw new Error("Shared-owner E2E requires --workers=1; global logout invalidates other workers");
    }
    if (!baseURL) throw new Error("Browser test baseURL is required");
    await ensureOwnerSession(browser, baseURL, testInfo.testId);
    await use();
  }, { auto: true }],
  // The default page/context must not read storageState until the auto
  // fixture has restored a revoked cookie. Also covers browser-only tests
  // which open newContext({ storageState: sessionFile }) themselves.
  storageState: async ({ ownerSession }, use) => {
    await use(sessionFile);
  },
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use({ "x-forwarded-for": clientAddress(testInfo.testId) });
  },
  pageErrors: [async ({ browser, context }, use, testInfo) => {
    const errors: string[] = [];
    const contexts = new Set<BrowserContext>();
    const watchPage = (page: Page) => page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message} (${page.url()})`));
    const watch = (watched: BrowserContext) => {
      contexts.add(watched);
      watched.pages().forEach(watchPage);
      watched.on("page", watchPage);
    };
    watch(context);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args: Parameters<typeof newContext>) => {
      // Contexts a scenario opens itself (a second device) count as the same client.
      const [options = {}] = args;
      const created = await newContext({ ...options, extraHTTPHeaders: { "x-forwarded-for": clientAddress(testInfo.testId), ...options.extraHTTPHeaders } });
      watch(created);
      return created;
    };
    try {
      await use();
    } finally {
      browser.newContext = newContext;
    }
    // A round trip to each page that is still open delivers every error it reported before.
    for (const watched of contexts) {
      for (const page of watched.pages()) await page.evaluate(() => 0).catch(() => undefined);
    }
    if (errors.length && testInfo.status === testInfo.expectedStatus) {
      throw new Error(`The page reported ${errors.length} error(s):\n${errors.join("\n")}`);
    }
  }, { auto: true }],
});

export { expect };
