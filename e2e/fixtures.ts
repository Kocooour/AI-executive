import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

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

export const test = base.extend<{ pageErrors: void }>({
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
