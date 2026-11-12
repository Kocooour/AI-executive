/**
 * H1-real.9: real mounted React/Next Context acceptance in isolated Chromium.
 * Opt in ONLY via LUMI_HUMANWIKI_SOURCE_STATUS_E2E=true on throwaway E2E
 * server; the production backend is NOT enabled. Network responses below
 * are isolated, synthetic, owner-shaped route fixtures.
 */
import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";

const routePattern = "**/api/humanwiki/source-witness-status";
const panelSelector = '[data-testid="humanwiki-source-status"]';
const outputSelector = '[data-testid="humanwiki-source-status-result"]';
const sample = {
  result: "source_intent_and_witness_observation_not_authorization",
  witnessState: "signed_witness_prefix_covers_owner_intents",
  sources: {
    chatgpt_user_export: { revision: 1, latestIntent: "withdrawal_requested" },
    claude_user_export: { revision: 0, latestIntent: null },
  },
  importAuthorized: false,
  consentVerified: false,
  independentWitnessVerified: false,
  withdrawalComplete: false,
  realImportEnabled: false,
  claimsCreated: 0,
};
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const respond = (route: Route, body: unknown = sample, status = 200) =>
  route.fulfill({ status, headers, body: JSON.stringify(body) });
const panel = (page: Page) => page.locator(panelSelector);
const status = (page: Page) => page.locator(outputSelector);
async function openContext(page: Page) {
  await page.goto("/?view=Context");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Ověřit stav zdrojů" })).toBeEnabled();
  await expect(status(page)).toHaveCount(0);
}
async function clickCheck(page: Page) {
  await panel(page).getByRole("button", { name: "Ověřit stav zdrojů" }).click();
}
test.describe("H1-real.9 focused owner status browser integration", () => {
  test.skip(process.env.LUMI_HUMANWIKI_SOURCE_STATUS_E2E !== "true",
    "Requires isolated focused test server with both HumanWiki UI/API opt-in gates.");

  test("desktop: click sends one credentialed no-store GET and renders ONLY owner intent", async ({ page }) => {
    let count = 0;
    await page.route(routePattern, async route => {
      count++;
      expect(route.request().method()).toBe("GET");
      expect(route.request().postData()).toBeNull();
      expect(route.request().headers().accept).toContain("application/json");
      expect(route.request().headers().cookie).toBeTruthy();
      await respond(route);
    });
    await openContext(page);
    expect(count, "no automatic owner-status request on navigation").toBe(0);
    await clickCheck(page);
    await expect(status(page)).toContainText("Export ChatGPT");
    await expect(status(page)).toContainText("Zapsaná žádost o odvolání — není dokončeno");
    await expect(status(page)).toContainText("Žádná žádost nezapsána");
    await expect(status(page)).toContainText("Podepsaný svědek pokrývá");
    await expect(status(page)).toContainText("nepotvrzuje výmaz");
    expect(count).toBe(1);
    await expect(status(page)).not.toContainText(/owner-alice|sourceId|event_mac|digest|importAuthorized/);
  });

  test("mobile More → Kontext: leaving and returning wipes private state without auto-fetch", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let count = 0;
    await page.route(routePattern, route => { count++; return respond(route); });
    await page.goto("/");
    const nav = page.locator(".mobileNav");
    await expect(nav).toBeVisible();
    await nav.locator('button[data-nav-view="More"]').click();
    await page.locator('.mobileMoreItem[data-nav-view="Context"]').click();
    await expect(panel(page)).toBeVisible();
    expect(count).toBe(0);
    await clickCheck(page);
    await expect(status(page)).toContainText("Export ChatGPT");
    await nav.locator('button[data-nav-view="Projects"]').click();
    await expect(panel(page)).toHaveCount(0);
    await nav.locator('button[data-nav-view="More"]').click();
    await page.locator('.mobileMoreItem[data-nav-view="Context"]').click();
    await expect(panel(page)).toBeVisible();
    await expect(status(page)).toHaveCount(0);
    await expect(panel(page)).toContainText("Stav se načítá pouze na vyžádání.");
    expect(count, "returning to Context must not implicitly re-fetch").toBe(1);
    await clickCheck(page);
    await expect(status(page)).toContainText("Export ChatGPT");
    expect(count).toBe(2);
  });

  test("404 and malformed/privileged status replace previous result with unavailable", async ({ page }) => {
    let count = 0;
    await page.route(routePattern, route => {
      count++;
      if (count === 1) return respond(route);
      if (count === 2) return respond(route, { error: "Not found" }, 404);
      return respond(route, { ...sample, importAuthorized: true, sourceId: "foreign-secret" });
    });
    await openContext(page);
    await clickCheck(page);
    await expect(status(page)).toContainText("Export ChatGPT");
    await clickCheck(page);
    await expect(panel(page).getByRole("alert")).toContainText("nelze bezpečně ověřit");
    await expect(status(page)).toHaveCount(0);
    await clickCheck(page);
    await expect(panel(page).getByRole("alert")).toContainText("nelze bezpečně ověřit");
    await expect(status(page)).toHaveCount(0);
    await expect(panel(page)).not.toContainText("foreign-secret");
    expect(count).toBe(3);
  });

  test("late signed response after blur and view exit cannot resurrect previous owner's UI", async ({ page }) => {
    let release: () => void = () => { throw Error("route not initialized"); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    let delivered: () => void = () => { throw Error("not initialized"); };
    const deliveryAttempted = new Promise<void>(resolve => { delivered = resolve; });
    let count = 0;
    await page.route(routePattern, async route => {
      count++;
      if (count === 1) {
        try {
          await gate;
          // This attempts a synthetic late response even if the real browser
          // aborted the request when it lost focus.
          await respond(route).catch(() => undefined);
        } finally { delivered(); }
      } else await respond(route);
    });
    await openContext(page);
    const observed = page.waitForRequest(routePattern);
    await clickCheck(page);
    await observed;
    await expect(panel(page)).toContainText("Ověřuji");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(status(page)).toHaveCount(0);
    await expect(panel(page)).toContainText("Stav se načítá pouze na vyžádání.");
    release();
    await deliveryAttempted;
    await expect(status(page)).toHaveCount(0);
    // A route transition unmounts the source panel; the next mount has no
    // saved user data and does not automatically send a new request.
    await page.goto("/?view=Projects");
    await expect(panel(page)).toHaveCount(0);
    await openContext(page);
    expect(count).toBe(1);
    await clickCheck(page);
    await expect(status(page)).toContainText("Export ChatGPT");
    expect(count).toBe(2);
  });

  test("session removal while network is pending cannot render owner data after reload", async ({ page }) => {
    let release: () => void = () => { throw Error("route not initialized"); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    let delivered: () => void = () => { throw Error("not initialized"); };
    const deliveryAttempted = new Promise<void>(resolve => { delivered = resolve; });
    let count = 0;
    await page.route(routePattern, async route => {
      count++;
      try {
        await gate;
        await respond(route).catch(() => undefined);
      } finally { delivered(); }
    });
    await openContext(page);
    const observed = page.waitForRequest(routePattern);
    await clickCheck(page);
    await observed;
    await page.context().clearCookies();
    await page.reload();
    await expect(page.locator(".authShell")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    release();
    await deliveryAttempted;
    await expect(panel(page)).toHaveCount(0);
    expect(count).toBe(1);
  });
});
