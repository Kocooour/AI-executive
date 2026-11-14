import { readFileSync } from "node:fs";
import { sessionFile } from "../playwright.config";
import { expect, test } from "./fixtures";
import { settingsSections, waitUntilSynced } from "./helpers";

// Must execute consecutively against one synthetic server. The first test
// deliberately leaves the setup cookie revoked; the next proves the common
// fixture repairs it before constructing either an implicit or manual context.
test.describe.serial("C16 owner-session recovery", () => {
  test("C16: real logout revokes the shared browser-test cookie", async ({ browser, page }) => {
    await page.goto("/?view=Settings");
    await waitUntilSynced(page);
    const stored = JSON.parse(readFileSync(sessionFile, "utf8")) as {
      cookies: Array<{ name: string; value: string }>;
      origins: unknown[];
    };
    const initialCookie = stored.cookies.find((cookie) => cookie.name === "ai_executive_session")?.value;
    expect(initialCookie).toBeTruthy();
    expect(initialCookie).toBe((await page.context().cookies()).find((cookie) => cookie.name === "ai_executive_session")?.value);

    await settingsSections(page).filter({ hasText: "Přístup" }).click();
    await page.getByRole("button", { name: "Odhlásit se" }).click();
    await expect(page.locator(".authCard")).toBeVisible();
    expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(401);

    // The owner cookie persisted by auth.setup is now invalid on a second
    // device too. Test setup must not re-use it at the start of the next test.
    const staleDevice = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
    try {
      const stalePage = await staleDevice.newPage();
      await stalePage.goto("/");
      await expect(stalePage.locator(".authCard")).toBeVisible();
      expect(await stalePage.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(401);
    } finally {
      await staleDevice.close();
    }
  });

  test("C16: next test receives a fresh verified session without copied local data", async ({ page, browser }) => {
    const stored = JSON.parse(readFileSync(sessionFile, "utf8")) as {
      cookies: Array<{ name: string; value: string }>;
      origins: unknown[];
    };
    expect(stored.origins).toEqual([]);
    const cookie = stored.cookies.find((entry) => entry.name === "ai_executive_session")?.value;
    expect(cookie).toBeTruthy();
    expect(cookie).toBe((await page.context().cookies()).find((entry) => entry.name === "ai_executive_session")?.value);

    await page.goto("/?view=Inbox");
    await expect(page.locator(".appShell")).toBeVisible();
    await waitUntilSynced(page);
    expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(200);

    // Browser-only specs explicitly open contexts from sessionFile.
    const secondDevice = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
    try {
      const secondPage = await secondDevice.newPage();
      await secondPage.goto("/");
      await expect(secondPage.locator(".appShell")).toBeVisible();
      expect(await secondPage.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(200);
    } finally {
      await secondDevice.close();
    }
  });
});
