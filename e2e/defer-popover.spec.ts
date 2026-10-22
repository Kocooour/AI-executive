import type { Locator, Page } from "@playwright/test";
import { confirmDialog, expectOnServer, serverEntities, waitUntilSynced } from "./helpers";
import { expect, test } from "./fixtures";

// The "Kdy" popover on task rows (Things-style deferral). Tasks are added straight to the server
// store, as another device would, with titles unique to each scenario.

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

// Local calendar days, the way the app computes them (the browser's own time zone).
async function days(page: Page) {
  return page.evaluate(() => {
    const ymd = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    const at = (offset: number) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + offset); return date; };
    const weekday = at(0).getDay();
    return { today: ymd(at(0)), tomorrow: ymd(at(1)), nextMonday: ymd(at((8 - weekday) % 7 || 7)), offsets: Array.from({ length: 40 }, (_, index) => ymd(at(index))) };
  });
}

async function seed(page: Page, title: string, properties: Record<string, unknown>) {
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  const id = `e2e-defer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await addTasks(page, [{ id, title, properties }]);
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  return id;
}

const row = (page: Page, title: string) => page.locator(".taskRow", { hasText: title });
const chip = (page: Page, title: string) => row(page, title).locator(".deferChip");
const popover = (page: Page) => page.getByRole("dialog", { name: "Kdy" });
const taskOnServer = async (page: Page, id: string) => (await serverEntities(page)).find((entity) => entity.id === id);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function openCalendarDay(page: Page, day: string): Promise<Locator> {
  const button = popover(page).locator(`[data-day="${day}"]`);
  for (let attempt = 0; attempt < 3 && (await button.count()) === 0; attempt += 1) await popover(page).getByRole("button", { name: "Další měsíc" }).click();
  return button;
}

test("a task is deferred to next Monday from its date chip and Undo brings it back to Today", async ({ page }) => {
  const title = `Odložit na pondělí ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true, deadline: dates.offsets[20] });
  await expect(chip(page, title)).toHaveAttribute("aria-label", "Kdy: Dnes — změnit");
  await chip(page, title).click();
  await expect(popover(page)).toBeVisible();
  // The chip does not open the inspector.
  await expect(page.locator(".detail")).toHaveCount(0);
  await popover(page).getByRole("button", { name: /Příští týden/ }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(row(page, title)).toHaveCount(0);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.nextMonday, true);
  const saved = await taskOnServer(page, id);
  expect(saved?.properties?.deadline).toBe(dates.offsets[20]);
  expect(saved?.properties?.today).toBe(false);
  expect(saved?.properties?.deferHistory).toMatchObject([{ from: dates.today, to: dates.nextMonday, via: "manual" }]);
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await expect(row(page, title)).toBeVisible();
});

test("Undo after deferring restores the task in Today", async ({ page }) => {
  const title = `Odložit a vrátit ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true });
  await chip(page, title).click();
  await popover(page).getByRole("button", { name: /Příští týden/ }).click();
  await expect(row(page, title)).toHaveCount(0);
  await page.locator(".undo").getByRole("button", { name: "Zpět" }).click();
  await expect(row(page, title)).toBeVisible();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.today, true);
  expect((await taskOnServer(page, id))?.properties?.deferHistory ?? []).toHaveLength(0);
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await expect(row(page, title)).toHaveCount(0);
});

test("a day after the deadline asks first; declining changes nothing and the deadline is never changed", async ({ page }) => {
  const title = `Po termínu ${Date.now()}`;
  const dates = await days(page);
  const deadline = dates.offsets[5];
  const late = dates.offsets[7];
  const id = await seed(page, title, { when: dates.today, today: true, deadline });
  await chip(page, title).click();
  await (await openCalendarDay(page, late)).click();
  await expect(confirmDialog(page)).toBeVisible();
  await expect(confirmDialog(page)).toContainText("Po termínu?");
  await confirmDialog(page).getByRole("button", { name: "Zrušit" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  // The popover is still open and nothing changed.
  await expect(popover(page)).toBeVisible();
  await page.waitForTimeout(300);
  let saved = await taskOnServer(page, id);
  expect(saved?.properties?.when).toBe(dates.today);
  expect(saved?.properties?.deadline).toBe(deadline);
  await expect(page.locator(".undo")).toHaveCount(0);
  // Confirming plans the task for that day and still leaves the deadline alone.
  await (await openCalendarDay(page, late)).click();
  await confirmDialog(page).getByRole("button", { name: "Přesto naplánovat" }).click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === late, true);
  saved = await taskOnServer(page, id);
  expect(saved?.properties?.deadline).toBe(deadline);
  await expect(popover(page)).toHaveCount(0);
});

test("Lumi keeps a task with a deadline tomorrow in Today instead of suggesting a deferral", async ({ page }) => {
  const title = `Termín zítra ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true, deadline: dates.tomorrow });
  await chip(page, title).click();
  const suggestion = popover(page).getByRole("region", { name: "Návrh Lumi" });
  await expect(suggestion).toContainText("Lumi");
  await expect(suggestion).toContainText("Termín je zítra");
  const keep = suggestion.getByRole("button", { name: "Nechat na dnes" });
  await expect(keep).toBeVisible();
  await expect(suggestion.getByRole("button", { name: "Použít" })).toHaveCount(0);
  await keep.click();
  await expect(popover(page)).toHaveCount(0);
  await expect(row(page, title)).toBeVisible();
  await page.waitForTimeout(300);
  const saved = await taskOnServer(page, id);
  expect(saved?.properties?.when).toBe(dates.today);
  expect(saved?.properties?.deadline).toBe(dates.tomorrow);
  // The task is already in Today, so nothing was written and there is nothing to undo.
  await expect(page.locator(".undo")).toHaveCount(0);
});

test("a task without a deadline gets a one-click suggestion that can be applied", async ({ page }) => {
  const title = `Návrh Lumi ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true });
  await chip(page, title).click();
  const suggestion = popover(page).getByRole("region", { name: "Návrh Lumi" });
  await expect(suggestion).toContainText("Přesunout na");
  await suggestion.getByRole("button", { name: "Použít" }).click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when !== dates.today && Boolean(entity.properties?.when), true);
  const saved = await taskOnServer(page, id);
  expect(saved?.properties?.deferHistory).toMatchObject([{ from: dates.today, via: "lumi" }]);
});

test("This evening moves the task into its own group in Today", async ({ page }) => {
  const title = `Večerní úkol ${Date.now()}`;
  const other = `Denní úkol ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true });
  await addTasks(page, [{ id: `${id}-other`, title: other, properties: { when: dates.today, today: true } }]);
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await expect(page.locator(".eveningHeading", { hasText: title })).toHaveCount(0);
  await chip(page, title).click();
  await popover(page).getByRole("button", { name: /Dnes večer/ }).click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.evening === true && entity.properties?.when === dates.today, true);
  await expect(page.locator(".eveningHeading")).toHaveText("Dnes večer");
  // The task is in Today, listed after the heading; the other task stays before it.
  await expect(page.locator(".eveningHeading ~ .taskRow", { hasText: title })).toBeVisible();
  await expect(page.locator(".eveningHeading ~ .taskRow", { hasText: other })).toHaveCount(0);
  await expect(row(page, other)).toBeVisible();
  // The sidebar count of Today still includes it, and choosing Today again leaves the group.
  await chip(page, title).click();
  await popover(page).locator('[data-defer-choice="today"]').click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.evening === false, true);
  await expect(page.locator(".eveningHeading ~ .taskRow", { hasText: title })).toHaveCount(0);
  await expect(row(page, title)).toBeVisible();
});

test("on a phone the chip opens a bottom sheet and Tomorrow works without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `Mobilní odklad ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true });
  expect(await noHorizontalScroll(page)).toBe(true);
  await chip(page, title).click();
  const sheet = page.locator(".deferPopover.isSheet");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeLessThanOrEqual(391);
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(843);
  expect(await noHorizontalScroll(page)).toBe(true);
  for (const choice of await sheet.locator(".deferChoice").all()) expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sheet.getByRole("button", { name: /Zítra/ }).click();
  await expect(sheet).toHaveCount(0);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.tomorrow, true);
  await expect(row(page, title)).toHaveCount(0);
  await expect(page.locator(".undo")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("the chip and the calendar work from the keyboard and Escape returns focus to the chip", async ({ page }) => {
  const title = `Klávesnice ${Date.now()}`;
  const dates = await days(page);
  await seed(page, title, { when: dates.today, today: true });
  const trigger = chip(page, title);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeVisible();
  // The detail did not open by the same key press.
  await expect(page.locator(".detail")).toHaveCount(0);
  // The calendar grid is one tab stop; arrow keys move between days.
  const todayButton = popover(page).locator(`[data-day="${dates.today}"]`);
  await todayButton.focus();
  await expect(todayButton).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("ArrowRight");
  await expect(popover(page).locator(`[data-day="${dates.tomorrow}"]`)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).locator(`[data-day="${dates.offsets[8]}"]`)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // Clicking outside closes it as well.
  await trigger.click();
  await expect(popover(page)).toBeVisible();
  await page.locator(".pageTitleRow h1").click();
  await expect(popover(page)).toHaveCount(0);
});
