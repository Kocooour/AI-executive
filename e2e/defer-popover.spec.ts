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
    return { yesterday: ymd(at(-1)), today: ymd(at(0)), tomorrow: ymd(at(1)), nextMonday: ymd(at((8 - weekday) % 7 || 7)), offsets: Array.from({ length: 40 }, (_, index) => ymd(at(index))) };
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
// A change that must not happen: after the local copy is synced, the server value is checked repeatedly
// for about 1.5 s instead of after one fixed pause.
async function expectStays(page: Page, id: string, read: (properties: Record<string, unknown>) => unknown, expected: unknown) {
  await waitUntilSynced(page);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    expect(read((await taskOnServer(page, id))?.properties ?? {})).toEqual(expected);
    await page.waitForTimeout(250);
  }
}
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
  await expect(confirmDialog(page)).toContainText("(termín:");
  await confirmDialog(page).getByRole("button", { name: "Zrušit" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  // The popover is still open and nothing changed.
  await expect(popover(page)).toBeVisible();
  await expectStays(page, id, (properties) => properties.when, dates.today);
  let saved = await taskOnServer(page, id);
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

test("after a passed deadline Today is offered without a warning and Lumi says the deadline was missed", async ({ page }) => {
  const title = `Termín byl včera ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.offsets[2], deadline: dates.yesterday });
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await chip(page, title).click();
  const suggestion = popover(page).getByRole("region", { name: "Návrh Lumi" });
  await expect(suggestion).toContainText("Termín byl včera");
  // Today is the earliest day possible: not flagged and not confirmed.
  const todayChoice = popover(page).getByRole("button", { name: /^★?\s*Dnes\b/ }).first();
  await expect(todayChoice).not.toContainText("po termínu");
  await expect(popover(page).getByRole("button", { name: /Zítra/ })).toContainText("po termínu");
  await todayChoice.click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.today, true);
  expect((await taskOnServer(page, id))?.properties?.deadline).toBe(dates.yesterday);
  // The scenarios share one instance: complete the overdue task so later Home and attention scenarios do not see it.
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await row(page, title).locator("button.check").click();
  await expectOnServer(page, (entity) => entity.id === id && entity.status === "completed", true);
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
  await expectStays(page, id, (properties) => properties.when, dates.today);
  const saved = await taskOnServer(page, id);
  expect(saved?.properties?.deadline).toBe(dates.tomorrow);
  expect(saved?.properties?.deferHistory).toBeUndefined();
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
  await expect(chip(page, title)).toHaveText("Večer");
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
  // Focus moved into the popover (not left on the chip).
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Kdy"]')))).toBe(true);
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

test("the chip shows the planned day and the deadline is a separate badge", async ({ page }) => {
  const dates = await days(page);
  const passed = `Chip po termínu ${Date.now()}`;
  const soon = `Chip termín zítra ${Date.now()}`;
  const later = `Chip pozdější termín ${Date.now()}`;
  const none = `Chip bez data ${Date.now()}`;
  await seed(page, passed, { when: dates.today, today: true, deadline: "2000-01-01" });
  await addTasks(page, [
    { id: `e2e-chip-soon-${Date.now()}`, title: soon, properties: { when: dates.today, today: true, deadline: dates.tomorrow } },
    { id: `e2e-chip-later-${Date.now()}`, title: later, properties: { when: dates.offsets[3], deadline: dates.offsets[9], evening: false } },
    { id: `e2e-chip-none-${Date.now()}`, title: none, properties: {} },
  ]);
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  // The planned day, neutral; the passed deadline is a red badge next to it.
  await expect(chip(page, passed)).toHaveText("Dnes");
  await expect(chip(page, passed)).not.toHaveClass(/danger/);
  await expect(row(page, passed).locator(".deadlineBadge.isPassed")).toContainText("Termín:");
  await expect(chip(page, soon)).toHaveText("Dnes");
  await expect(row(page, soon).locator(".deadlineBadge.isSoon")).toContainText("Zítra");
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await expect(chip(page, later)).not.toHaveText("Dnes");
  await expect(row(page, later).locator(".deadlineBadge")).toHaveCount(1);
  await expect(row(page, later).locator(".deadlineBadge.isPassed, .deadlineBadge.isSoon")).toHaveCount(0);
  await page.goto("/?view=Anytime");
  await waitUntilSynced(page);
  await expect(row(page, none).locator(".deadlineBadge")).toHaveCount(0);
  await expect(chip(page, none)).toHaveAttribute("aria-label", "Kdy: bez data — změnit");
  // At rest the chip has a visible border, not plain text.
  const border = await chip(page, none).evaluate((element) => getComputedStyle(element).borderTopWidth);
  expect(border).toBe("1px");
});

test("past days cannot be chosen, today can", async ({ page }) => {
  const title = `Minulé dny ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.tomorrow });
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await chip(page, title).click();
  const yesterday = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); });
  const past = await openCalendarDay(page, yesterday);
  await expect(past).toHaveAttribute("aria-disabled", "true");
  await past.focus();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeVisible();
  await expectStays(page, id, (properties) => properties.when, dates.tomorrow);
  await expect(popover(page).locator(`[data-day="${dates.today}"]`)).not.toHaveAttribute("aria-disabled", "true");
  await popover(page).locator(`[data-day="${dates.today}"]`).click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.today, true);
});

test("a second choice while the first is saving is ignored and one Undo restores the original", async ({ page }) => {
  const title = `Dvojí volba ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, { when: dates.today, today: true });
  await page.route("**/api/store", async (route) => {
    if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await chip(page, title).click();
  // Both clicks arrive before the first save has finished.
  await popover(page).evaluate((element) => {
    (element.querySelector('[data-defer-choice="tomorrow"]') as HTMLElement).click();
    (element.querySelector('[data-defer-choice="nextWeek"]') as HTMLElement).click();
  });
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.tomorrow, true);
  await page.unroute("**/api/store");
  await waitUntilSynced(page);
  const saved = await taskOnServer(page, id);
  expect(saved?.properties?.when).toBe(dates.tomorrow);
  expect(saved?.properties?.deferHistory).toHaveLength(1);
  await page.locator(".undo").getByRole("button", { name: "Zpět" }).click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === dates.today, true);
});

test("changing the view closes the popover", async ({ page }) => {
  const title = `Zavřít při změně ${Date.now()}`;
  const dates = await days(page);
  await seed(page, title, { when: dates.today, today: true });
  await chip(page, title).click();
  await expect(popover(page)).toBeVisible();
  await page.locator("aside nav button", { hasText: "Doručené" }).first().click();
  await expect(popover(page)).toHaveCount(0);
});

test("keyboard moves in Today stay inside the regular or the evening group", async ({ page }) => {
  const stamp = Date.now();
  const dates = await days(page);
  const base = stamp + 1e9;
  const [a, b, e] = [`Pořadí A ${stamp}`, `Pořadí B ${stamp}`, `Pořadí večer ${stamp}`];
  await seed(page, a, { when: dates.today, today: true, manualOrder: base });
  await addTasks(page, [
    { id: `e2e-order-b-${stamp}`, title: b, properties: { when: dates.today, today: true, manualOrder: base + 1 } },
    { id: `e2e-order-e-${stamp}`, title: e, properties: { when: dates.today, today: true, evening: true, manualOrder: base + 2 } },
  ]);
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await expect(page.locator(".eveningHeading ~ .taskRow", { hasText: e })).toBeVisible();
  const handle = (title: string) => row(page, title).locator(".dragHandle");
  const orders = async () => (await serverEntities(page)).filter((entity) => entity.title.endsWith(String(stamp)) && entity.title.startsWith("Pořadí")).map((entity) => [entity.title, JSON.stringify(entity.properties?.manualOrders ?? null)]);
  // Down from the last regular task: the next row is in the other group, so nothing is written.
  await handle(b).focus();
  await page.keyboard.press("ArrowDown");
  await waitUntilSynced(page);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    expect((await orders()).every(([, value]) => value === "null")).toBe(true);
    await page.waitForTimeout(250);
  }
  // Up from the evening task: it is alone in its group.
  await handle(e).focus();
  await page.keyboard.press("ArrowUp");
  await waitUntilSynced(page);
  expect((await orders()).every(([, value]) => value === "null")).toBe(true);
  // Within the group a move is written.
  await handle(b).focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await orders()).find(([title]) => title === b)?.[1]).not.toBe("null");
  const regular = await page.locator(".taskRow:not(.eveningHeading ~ .taskRow)").allTextContents();
  expect(regular.findIndex((text) => text.includes(b))).toBeLessThan(regular.findIndex((text) => text.includes(a)));
});

test("a recurring task completed in the evening group starts its next occurrence without the evening mark or deferral history", async ({ page }) => {
  const title = `Opakovaný večer ${Date.now()}`;
  const dates = await days(page);
  const id = await seed(page, title, {
    when: dates.today, today: true, evening: true, recurrence: { frequency: "daily", interval: 1, mode: "scheduled" },
    deferHistory: [{ from: dates.today, to: dates.tomorrow, at: 1, via: "manual" }],
  });
  await row(page, title).locator(".check").click();
  await expect.poll(async () => (await serverEntities(page)).find((entity) => entity.id.startsWith(`${id}:occurrence:`))?.properties?.when, { timeout: 20_000 }).toBeTruthy();
  const next = (await serverEntities(page)).find((entity) => entity.id.startsWith(`${id}:occurrence:`));
  expect(next?.properties?.evening).toBe(false);
  expect(next?.properties?.deferHistory).toEqual([]);
});
