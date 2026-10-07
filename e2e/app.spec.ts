import { expect, test } from "@playwright/test";
import { confirmDialog, expectOnServer, heading, seeded, settingsSections, sidebarView, signIn, waitUntilSynced } from "./helpers";

// The scenarios share one instance and run in this order, one at a time (see the config).
// A failing scenario does not stop the ones after it. Signing out comes last.

// The app must never fall back to a system dialog; if one appears it is dismissed and the scenario fails.
const systemDialogs: string[] = [];
test.beforeEach(async ({ page }) => {
  systemDialogs.length = 0;
  page.on("dialog", (dialog) => { systemDialogs.push(dialog.message()); void dialog.dismiss(); });
});
test.afterEach(() => {
  expect(systemDialogs).toEqual([]);
});

test("Home shows the brief with seeded attention", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".appShell")).toBeVisible();
  const attention = page.locator(".attentionSection");
  await expect(attention.locator(".attentionItem", { hasText: seeded.overdueTask })).toBeVisible();
  await expect(attention.locator(".attentionStale")).toHaveCount(0);
});

test("a captured task appears in Inbox and reaches the server", async ({ page }) => {
  const title = `Zachycený úkol ${Date.now()}`;
  await page.goto("/");
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  await modal.locator("input, textarea").first().fill(title);
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await sidebarView(page, "Doručené").click();
  await expect(page.getByText(title)).toBeVisible();
  await expectOnServer(page, (entity) => entity.title === title, true);
});

test("the address follows the view; Back, Forward and reload keep the place", async ({ page }) => {
  await page.goto("/");
  await expect(heading(page)).toBeVisible();
  await sidebarView(page, "Projekty").click();
  await expect(page).toHaveURL(/\?view=Projects$/);
  await sidebarView(page, "Dnes").click();
  await expect(page).toHaveURL(/\?view=Today$/);
  await page.goBack();
  await expect(page).toHaveURL(/\?view=Projects$/);
  await expect(heading(page)).toHaveText("Projekty");
  await page.goForward();
  await expect(heading(page)).toHaveText("Dnes");
  await page.reload();
  await expect(heading(page)).toHaveText("Dnes");
  await page.goto("/?view=Nonsense&workspace=personal");
  await expect(page).toHaveURL(/\/$/);
});

test("a task link opens the task and its id leaves the address", async ({ page }) => {
  await page.goto("/?task=e2e-plain");
  await expect(page.locator(`input[value="${seeded.plainTask}"]`)).toBeVisible();
  await expect(page).not.toHaveURL(/task=/);
});

test("deleting a project asks in the app dialog; Escape cancels, confirming deletes", async ({ page }) => {
  await page.goto("/?view=Projects");
  await page.getByText(seeded.project).first().click();
  const remove = page.locator(".projectActions button.danger");
  const dialog = confirmDialog(page);
  await remove.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  // Cancelled means still there after everything has been sent and the page loaded again.
  await waitUntilSynced(page);
  await page.reload();
  await page.getByText(seeded.project).first().click();
  await expectOnServer(page, (entity) => entity.id === "e2e-project", true);
  await remove.click();
  await expect(dialog).toHaveRole("alertdialog");
  await dialog.getByRole("button", { name: "Smazat" }).click();
  await expect(dialog).toHaveCount(0);
  await expectOnServer(page, (entity) => entity.id === "e2e-project", false);
});

test("Settings shows one section at a time", async ({ page }) => {
  await page.goto("/?view=Settings");
  const tabs = settingsSections(page);
  await expect(tabs).toHaveText(["Obecné", "Workspace", "Přístup", "Oznámení", "Kalendář", "Data a zálohy", "Kontext"]);
  const visibleHeadings = page.locator(".settingsPanel section:not([hidden]) h2");
  await expect(visibleHeadings).toHaveText(["Obecné", "Instalace aplikace"]);
  await tabs.filter({ hasText: "Oznámení" }).click();
  await expect(visibleHeadings).toHaveText(["Připomínky"]);
  await expect(page.locator(".settingsPanel section:not([hidden]) .badgeDiagnostics")).toBeVisible();
});

test("losing the connection keeps the attention list and marks it out of date", async ({ page, context }) => {
  await page.goto("/");
  const attention = page.locator(".attentionSection");
  await expect(attention.locator(".attentionItem").first()).toBeVisible();
  await context.setOffline(true);
  await expect(attention.locator(".attentionStale")).toBeVisible();
  await expect(attention.locator(".attentionItem").first()).toBeVisible();
  await attention.locator(".attentionMore summary").first().click();
  await expect(attention.locator(".attentionActions button").first()).toBeDisabled();
  await context.setOffline(false);
  // Well under the one-minute periodic refresh: coming back online must refresh by itself.
  await expect(attention.locator(".attentionStale")).toHaveCount(0, { timeout: 15_000 });
});

test.describe("on a phone-sized screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the brief and the bottom navigation work without sideways scrolling", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".attentionSection .attentionItem").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(".mobileNav button", { hasText: "Doručené" }).click();
    await expect(heading(page)).toHaveText("Doručené");
    await expect(page).toHaveURL(/\?view=Inbox$/);
    await expect(page.getByText(seeded.plainTask)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test("signing out without a connection is refused and removes nothing", async ({ page, context }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator("p.formError")).toContainText("Server není dostupný");
  await expect(page.locator(".appShell")).toBeVisible();
  expect(await page.evaluate(() => indexedDB.databases().then((list) => list.some((database) => database.name === "ai-executive")))).toBe(true);
  await context.setOffline(false);
});

test("signing out clears the local copy; signing in again restores it from the server", async ({ page }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  // Everything was sent, so no question about discarding changes may appear.
  await expect(page.locator(".authCard")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  const local = await page.evaluate(() => new Promise<string[]>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const all = request.result.transaction("entities").objectStore("entities").getAll();
      all.onsuccess = () => { resolve(all.result.map((entity: { title: string }) => entity.title)); request.result.close(); };
    };
  }));
  // Only the empty placeholder workspace may be there (it is created when the sign-in screen loads).
  expect(local.filter((title) => title !== "Personal")).toEqual([]);
  expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(401);
  await signIn(page);
  await sidebarView(page, "Doručené").click();
  await expect(page.getByText(seeded.plainTask)).toBeVisible();
});
