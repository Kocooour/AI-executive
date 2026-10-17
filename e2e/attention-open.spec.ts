import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { expectOnServer, serverEntities, waitUntilSynced } from "./helpers";

const pragueDate = (page: Page, days: number) => page.evaluate((offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" })
  .format(new Date(Date.now() + offset * 86_400_000)), days);

async function attentionItem(page: Page, title: string) {
  await page.goto("/");
  await waitUntilSynced(page);
  const more = page.locator(".attentionSection button.textAction", { hasText: "Zobrazit dalších" });
  if (await more.count()) await more.click();
  return page.locator(".attentionItem", { hasText: title });
}

// A task whose planned day has passed and is still open needs attention (owner decision
// 2026-10-09); planning it again ends that.
test("a task whose planned day has passed is shown as needing attention", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Prošlý den ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const yesterday = await pragueDate(page, -1);
  await page.locator(".detail input[type=date][aria-label='Kdy']").fill(yesterday);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === yesterday, true);
  const item = await attentionItem(page, title);
  await expect(item).toContainText("Naplánovaný den včera uplynul a úkol není hotový");
  await expect(item).toContainText("naplánovaný den");
  // Planned for tomorrow, it no longer needs attention.
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const tomorrow = await pragueDate(page, 1);
  await page.locator(".detail input[type=date][aria-label='Kdy']").fill(tomorrow);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === tomorrow, true);
  await expect(await attentionItem(page, title)).toHaveCount(0);
});

// The last evaluation is kept in this browser: when the server cannot evaluate after a restart,
// Home shows it marked as out of date, and snooze and dismiss wait.
test("the last attention evaluation is shown out of date when the server cannot evaluate", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const first = page.locator(".attentionItem").first();
  await expect(first).toBeVisible();
  const title = (await first.locator("strong").textContent()) || "";
  // While the server is still evaluating, the copy from this browser is shown as such.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/attention**", async (route) => { await held; await route.continue(); });
  await page.reload();
  await expect(page.locator(".attentionStale")).toContainText("Uloženo v zařízení, ověřuji změny");
  release();
  await expect(page.locator(".attentionStale")).toHaveCount(0);
  await page.unroute("**/api/attention**");
  await page.route("**/api/attention**", (route) => route.abort());
  await page.reload();
  await waitUntilSynced(page);
  await expect(page.locator(".attentionStale")).toBeVisible();
  await expect(page.locator(".attentionItem", { hasText: title }).first()).toBeVisible();
  await page.locator(".attentionItem").first().locator("summary").click();
  await expect(page.locator(".attentionItem").first().getByRole("button", { name: "Skrýt" })).toBeDisabled();
  await page.unroute("**/api/attention**");
  await page.getByRole("button", { name: "Obnovit" }).first().click();
  await expect(page.locator(".attentionStale")).toHaveCount(0);
});

// Started without any connection, the app shows this browser's data (owner decision 2026-10-09)
// and the last attention evaluation, marked as offline.
test("a start without connection shows the last attention evaluation marked as offline", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const first = page.locator(".attentionItem").first();
  await expect(first).toBeVisible();
  const title = (await first.locator("strong").textContent()) || "";
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  await expect(page.locator(".attentionStale")).toContainText("Jste offline");
  await expect(page.locator(".attentionItem", { hasText: title }).first()).toBeVisible();
  await page.unroute("**/api/**");
});
