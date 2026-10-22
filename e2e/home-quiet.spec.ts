import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { heading, seeded, waitUntilSynced } from "./helpers";

// The quiet Home of docs/design-system: a plain title, no status chips while all is well, and
// every recommendation says why, from what and when on its own line (docs/UX-UI.md, LUMI-UX-001).

// Adds tasks straight to the server store, as another device would (with the restore generation, since
// other specs restore backups), retrying when a save of the open page takes the revision first.
async function addTasks(page: Page, tasks: { id: string; title: string; properties: Record<string, unknown> }[]) {
  await expect.poll(() => page.evaluate(async (newTasks) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
      entities: [...snapshot.entities, ...newTasks.map((task) => ({ ...task, type: "task", status: "open", workspaceId: "personal", createdAt: now, updatedAt: now }))],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    return response.status;
  }, tasks), { timeout: 15_000 }).toBe(200);
}

test("Home has a plain title and shows only states that need something", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  await expect(heading(page)).toHaveText("Domů");
  await expect(page.locator(".pageSubtitle, .eyebrow, .homeStatus")).toHaveCount(0);
  // Synced: no sync line. The test instance has no calendar, so that one line is shown with a way to fix it.
  await expect(page.locator(".homeNotice.homeSync")).toHaveCount(0);
  await expect(page.locator(".homeNotice", { hasText: "Kalendář není připojen" }).getByRole("button", { name: "Připojit" })).toBeVisible();
});

test("workspace context stays visible away from Home", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  await expect(page.locator(".pageIntro .eyebrow")).toHaveCount(0);

  await page.goto("/?view=Today");
  await expect(heading(page)).toHaveText("Dnes");
  await expect(page.locator(".pageIntro .eyebrow")).toContainText(" · ");
  await expect(page.locator(".pageIntro .eyebrow")).toContainText("PERSONAL");
});

test("a recommendation shows reason, source and evaluation time without opening anything", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const item = page.locator(".attentionItem", { hasText: seeded.overdueTask }).first();
  await expect(item).toBeVisible();
  const why = item.locator(".attentionWhy");
  await expect(why).toBeVisible();
  await expect(why).toContainText("uplynul");
  await expect(why).toContainText("zaznamenaný termín");
  // The evaluation time is shown once, in the section header, not on every item.
  await expect(why).not.toContainText("vyhodnoceno");
  await expect(page.locator(".attentionSection .attentionUpdated")).toHaveCount(1);
  await expect(page.locator(".attentionSection .attentionUpdated")).toContainText(/Aktualizováno \d{1,2}:\d{2}/);
  // Source ids and revisions stay one step away, in the item's own Zdroje (in its "⋯" menu), with the evaluation time.
  await expect(item.locator(".attentionSources")).toBeHidden();
  await item.getByRole("button", { name: /^Další akce/ }).click();
  await item.getByRole("menuitem", { name: "Zdroje" }).click();
  await expect(item.locator(".attentionSources")).toBeVisible();
  await expect(item.locator(".attentionMore")).toContainText("vyhodnoceno");
});

test("snooze and dismiss are in the item's menu, reachable by mouse and keyboard", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const item = page.locator(".attentionItem").first();
  await expect(item).toBeVisible();
  // Closed: only the primary action and the "⋯" button; snooze and dismiss are not on the row.
  await expect(item.getByRole("menuitem")).toHaveCount(0);
  const menuButton = item.getByRole("button", { name: /^Další akce/ });
  await menuButton.focus();
  await page.keyboard.press("Enter");
  await expect(item.getByRole("menuitem", { name: /^Odložit o 24 h/ })).toBeVisible();
  await expect(item.getByRole("menuitem", { name: /^Skrýt/ })).toBeVisible();
  await expect(item.getByRole("menuitem", { name: "Zdroje" })).toBeVisible();
  // The first entry has focus; arrows move, Esc closes and gives focus back to the "⋯" button.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(item.getByRole("menuitem")).toHaveCount(0);
  await expect(menuButton).toBeFocused();
});

test("an ordinary save does not push the list down; a slow one and offline are shown", async ({ page, context }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  // Its own tasks for today, first in the Home list, completed on Home: saves that leave Home and the
  // recommendations in place.
  const title = `Uložení z Home ${Date.now()}`;
  const offlineTitle = `${title} offline`;
  const stamp = Date.now();
  await addTasks(page, [
    { id: `e2e-home-save-${stamp}`, title, properties: { today: true, manualOrder: -stamp - 1 } },
    { id: `e2e-home-save-offline-${stamp}`, title: offlineTitle, properties: { today: true, manualOrder: -stamp } },
  ]);
  await page.goto("/");
  await waitUntilSynced(page);
  const first = page.locator(".attentionItem").first();
  await expect(first).toBeVisible();
  const complete = page.getByRole("button", { name: `Complete ${title}`, exact: true });
  await expect(complete).toBeVisible();
  const before = (await first.boundingBox())!.y;
  // The server takes 3 s to answer the save.
  await page.route("**/api/store", async (route) => {
    if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await complete.click();
  // During the first second: no line, the list stays where it was.
  await page.waitForTimeout(800);
  await expect(page.locator(".homeNotice.homeSync")).toHaveCount(0);
  expect((await first.boundingBox())!.y).toBe(before);
  // A save still running after 2 s is shown, and the line goes once it is saved.
  await expect(page.locator(".homeNotice.homeSync")).toBeVisible();
  await expect(page.locator(".homeNotice.homeSync")).toHaveCount(0, { timeout: 10_000 });
  await page.unroute("**/api/store");
  // Offline: a save that cannot reach the server shows the line at once.
  await context.setOffline(true);
  await page.getByRole("button", { name: `Complete ${offlineTitle}` }).click();
  await expect(page.locator(".homeNotice.homeSync")).toContainText("Offline", { timeout: 2_000 });
  await context.setOffline(false);
});

test("after dismissing from the keyboard, focus moves to the next recommendation", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  // Its own overdue task, so dismissing it leaves the shared seeded items alone.
  const title = `Fokus po skrytí ${Date.now()}`;
  const deadline = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  await addTasks(page, [{ id: `e2e-focus-dismiss-${Date.now()}`, title, properties: { deadline } }]);
  await page.goto("/");
  await waitUntilSynced(page);
  // Other specs may leave more than five recommendations; the new one can be past the first five.
  const more = page.locator(".attentionSection button.textAction", { hasText: "Zobrazit dalších" });
  if (await more.count()) await more.click();
  const item = page.locator(".attentionSection .attentionItem", { hasText: title });
  await expect(item).toBeVisible();
  await page.keyboard.press("Shift");
  await item.getByRole("button", { name: /^Další akce/ }).click();
  await item.getByRole("menuitem", { name: `Skrýt: ${title}` }).focus();
  await page.keyboard.press("Enter");
  await expect(item).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active && (active.classList.contains("attentionOpen") || active.id === "attention-title"));
  })).toBe(true);
});

test.describe("on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the item's menu button is always visible and a 44px target", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const item = page.locator(".attentionItem").first();
    const menuButton = item.getByRole("button", { name: /^Další akce/ });
    await expect(menuButton).toBeVisible();
    const box = await menuButton.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await menuButton.click();
    await expect(item.getByRole("menuitem", { name: /^Skrýt/ })).toBeVisible();
  });

  test("the calendar notice's Připojit button is a 44px target", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    const connect = page.locator(".homeNotice").getByRole("button", { name: "Připojit" });
    const box = await connect.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });
});
