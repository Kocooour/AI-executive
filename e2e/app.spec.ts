import { expect, test } from "@playwright/test";
import { heading, seeded, serverEntities, sidebarView, signIn, waitForSync } from "./helpers";

// The scenarios share one instance and run in this order; signing out comes last.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  page.on("dialog", (dialog) => { throw new Error(`Unexpected system dialog: ${dialog.message()}`); });
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
  await modal.locator('button[type="submit"]').click();
  await expect(modal).toHaveCount(0);
  await sidebarView(page, "Doručené").click();
  await expect(page.getByText(title)).toBeVisible();
  await waitForSync(page);
  expect((await serverEntities(page)).some((entity) => entity.title === title)).toBe(true);
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
  const dialog = page.locator("dialog.confirmDialog");
  await remove.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect((await serverEntities(page)).some((entity) => entity.id === "e2e-project")).toBe(true);
  await remove.click();
  await dialog.locator("button").last().click();
  await expect(dialog).toHaveCount(0);
  await waitForSync(page);
  expect((await serverEntities(page)).some((entity) => entity.id === "e2e-project")).toBe(false);
});

test("Settings shows one section at a time", async ({ page }) => {
  await page.goto("/?view=Settings");
  const tabs = page.locator(".settingsTabs button");
  await expect(tabs).toHaveText(["Obecné", "Workspace", "Přístup", "Oznámení", "Kalendář", "Data a zálohy", "Kontext"]);
  const visibleHeadings = page.locator(".settingsPanel section:not([hidden]) h2");
  await expect(visibleHeadings).toHaveText(["Obecné", "Instalace aplikace"]);
  await tabs.nth(3).click();
  await expect(visibleHeadings).toHaveText(["Připomínky"]);
  await expect(page.locator(".settingsPanel section:not([hidden]) .badgeDiagnostics")).toBeVisible();
});

test("losing the connection keeps the attention list and marks it out of date", async ({ page, context }) => {
  await page.goto("/");
  const attention = page.locator(".attentionSection");
  await expect(attention.locator(".attentionItem").first()).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(attention.locator(".attentionStale")).toBeVisible();
  await expect(attention.locator(".attentionItem").first()).toBeVisible();
  await attention.locator(".attentionMore summary").first().click();
  await expect(attention.locator(".attentionActions button").first()).toBeDisabled();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(attention.locator(".attentionStale")).toHaveCount(0, { timeout: 20_000 });
});

test("signing out without a connection is refused and removes nothing", async ({ page, context }) => {
  await page.goto("/?view=Settings");
  await page.locator(".settingsTabs button", { hasText: "Přístup" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator("p.formError")).toContainText("Server není dostupný");
  await expect(page.locator(".appShell")).toBeVisible();
  expect(await page.evaluate(() => indexedDB.databases().then((list) => list.some((database) => database.name === "ai-executive")))).toBe(true);
  await context.setOffline(false);
});

test("signing out clears the local copy; signing in again restores it from the server", async ({ page }) => {
  await page.goto("/?view=Settings");
  await page.locator(".settingsTabs button", { hasText: "Přístup" }).click();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
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
