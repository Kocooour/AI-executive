import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { confirmDialog, heading, removeTasks, seedTasks, serverEntities, waitUntilSynced } from "./helpers";

// D2 (docs/proposals/2026-10-zjednoduseni-ui.md §5.2, §5.3): Today is one list (the day plan is a time
// cell in each row), Home shows each attention item with one primary action and its other actions in a
// "⋯" menu, and Home's Today leaves out what attention already shows. Every scenario seeds tasks with
// titles of its own and removes them again: the instance is shared, and a task with a passed or close
// deadline would push items out of Home for the scenarios after it.

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const day = (page: Page, offset: number) => page.evaluate((days) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}, offset);
const row = (page: Page, title: string) => page.locator(".taskRow", { hasText: title });

// The plan the server would compute is replaced by a fixed one for the tasks given (proposed block,
// unscheduled), so these scenarios do not depend on a calendar.
async function mockPlan(page: Page, plan: { proposed?: Array<{ id: string; title: string }>; unscheduled?: Array<{ id: string; title: string }> }) {
  await page.route("**/api/day-plan?**", async (route) => {
    const request = new URL(route.request().url());
    const date = request.searchParams.get("date") || "";
    const workspaceId = request.searchParams.get("workspaceId") || "personal";
    const shared = { estimatedMinutes: 30, reason: "today", estimateSource: "explicit", estimateSamples: 0, preferredMinute: null, timeSamples: 0, whyNow: ["due_today"] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      revision: 1, date, workspaceId, timezone: "Europe/Prague", calendar: "ready", freeMinutes: 600, requiredMinutes: 60, overloaded: false,
      existingBlocks: [],
      planBlocks: (plan.proposed || []).map((task, index) => ({ ...shared, taskId: task.id, title: task.title, start: `${date}T${String(11 + index).padStart(2, "0")}:00:00+02:00`, end: `${date}T${String(11 + index).padStart(2, "0")}:30:00+02:00` })),
      unscheduled: (plan.unscheduled || []).map((task) => ({ ...shared, taskId: task.id, title: task.title })),
    }) });
  });
}

test("Today is one list: no plan card, no idle work card, a time cell per planned row, the plan reasons and actions in its menu", async ({ page }) => {
  const id = stamp();
  const proposed = { id: `e2e-d2-prop-${id}`, title: `Navržený blok ${id}` };
  const unscheduled = { id: `e2e-d2-unsch-${id}`, title: `Bez času ${id}` };
  const unplanned = { id: `e2e-d2-none-${id}`, title: `Mimo plán ${id}` };
  const outside = { id: `e2e-d2-out-${id}`, title: `Termín zítra ${id}` };
  const tasks = [proposed, unscheduled, unplanned];
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  const tomorrow = await day(page, 1);
  await seedTasks(page, [...tasks.map((task) => ({ ...task, properties: { today: true } })), { ...outside, properties: { deadline: tomorrow } }]);
  try {
    await mockPlan(page, { proposed: [proposed], unscheduled: [unscheduled, outside] });
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    await expect(heading(page)).toHaveText("Dnes");
    await expect(row(page, proposed.title)).toBeVisible();

    // One list: no separate plan card or its groups, and no card saying that nothing runs.
    await expect(page.locator(".dayPlanCard, .dayPlanGroup, .dayPlanBlock")).toHaveCount(0);
    await expect(page.locator(".workNowCard")).toHaveCount(0);
    await expect(page.getByText("Žádný úkol právě neběží")).toHaveCount(0);

    // Header: "N úkolů · ~X h", the plan's estimates (30 + 30 min for the two planned Today tasks) rounded to half hours.
    await expect(page.locator("[data-today-summary]")).toHaveText(/^\d+ úkol(y|ů)? · ~1 h$/);

    // Time cells: proposal (muted, dotted), unscheduled ("—"), not in the plan (nothing).
    const proposedCell = row(page, proposed.title).locator("[data-time-cell]");
    await expect(proposedCell).toHaveAttribute("data-time-kind", "proposed");
    await expect(proposedCell).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    await expect(proposedCell).toHaveCSS("text-decoration-style", "dotted");
    await expect(row(page, unscheduled.title).locator("[data-time-cell]")).toHaveText("—");
    await expect(row(page, unplanned.title).locator("[data-time-cell]")).toHaveCount(0);
    // A plan item for a task that is not in Today is not a row.
    await expect(row(page, outside.title)).toHaveCount(0);

    // The menu: the reason ("Proč právě teď") and the plan actions, Esc closes and gives focus back.
    await proposedCell.click();
    const menu = page.locator(`[data-time-menu="${proposed.id}"]`);
    await expect(menu).toContainText("Proč právě teď");
    await expect(menu.locator(".timeMenuWhy li")).toHaveText(["Úkol má termín dnes."]);
    for (const name of ["Přijmout", "Jiný čas", "Zítra", "Neplánovat"]) await expect(menu.getByRole("button", { name })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(proposedCell).toBeFocused();
    // "Jiný čas" opens the task detail.
    await proposedCell.click();
    await page.locator(`[data-time-menu="${proposed.id}"]`).getByRole("button", { name: "Jiný čas" }).click();
    await expect(page.locator("aside.detail")).toHaveAttribute("aria-label", `Úkol: ${proposed.title}`);
    await page.locator("aside.detail button.close").click();
    // An unscheduled task has no "Přijmout".
    await row(page, unscheduled.title).locator("[data-time-cell]").click();
    const unscheduledMenu = page.locator(`[data-time-menu="${unscheduled.id}"]`);
    await expect(unscheduledMenu.getByRole("button", { name: "Přijmout" })).toHaveCount(0);
    await expect(unscheduledMenu.getByRole("button", { name: "Neplánovat" })).toBeVisible();
    await page.keyboard.press("Escape");

    // One quiet line below the list for the plan items that are not in Today, linking to Home.
    const line = page.locator("[data-today-outside]");
    await expect(line).toHaveText("Mimo Dnes je 1 úkol s blízkým termínem nebo prioritou — Zobrazit na Domů");
    await line.getByRole("button", { name: "Zobrazit na Domů" }).click();
    await expect(heading(page)).toHaveText("Domů");
  } finally {
    await page.unroute("**/api/day-plan?**");
    await removeTasks(page, [...tasks, outside].map((task) => task.id));
  }
});

test("a plan action in the time menu keeps its confirmation and Undo: Zítra moves the task and Undo brings it back", async ({ page }) => {
  const id = stamp();
  const task = { id: `e2e-d2-tomorrow-${id}`, title: `Přesun zítra ${id}` };
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await seedTasks(page, [{ ...task, properties: { today: true } }]);
  try {
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    // The test instance has no calendar, so the server plan lists the task without a time.
    const cell = row(page, task.title).locator("[data-time-cell]");
    await expect(cell).toHaveText("—");
    await cell.click();
    await page.locator(`[data-time-menu="${task.id}"]`).getByRole("button", { name: "Zítra" }).click();
    // The same confirmation as the plan cards had; cancelling changes nothing.
    await expect(confirmDialog(page)).toBeVisible();
    await expect(confirmDialog(page)).toContainText("Přesunout na zítra?");
    await confirmDialog(page).getByRole("button", { name: "Zrušit" }).click();
    await expect(row(page, task.title)).toHaveCount(1);
    await cell.click();
    await page.locator(`[data-time-menu="${task.id}"]`).getByRole("button", { name: "Zítra" }).click();
    await confirmDialog(page).getByRole("button", { name: "Zítra" }).click();
    await expect(row(page, task.title)).toHaveCount(0);
    const undo = page.getByRole("button", { name: "Vrátit poslední změnu plánu" });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(row(page, task.title)).toHaveCount(1);
    await expect(undo).toHaveCount(0);
  } finally {
    await removeTasks(page, [task.id]);
  }
});

test("Priorita and Řazení are in the ⋯ menu of the Today header; one calendar sentence in the footer", async ({ page }) => {
  const id = stamp();
  const high = { id: `e2e-d2-high-${id}`, title: `Vysoká ${id}` };
  const plain = { id: `e2e-d2-plain-${id}`, title: `Obyčejná ${id}` };
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await seedTasks(page, [{ ...high, properties: { today: true, priority: "high" } }, { ...plain, properties: { today: true } }]);
  try {
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    await expect(row(page, plain.title)).toBeVisible();
    // Not on the page until the menu is opened.
    await expect(page.locator(".todayOptionsBody select").first()).toHaveCount(0);
    const menuButton = page.locator("[data-today-menu]");
    await expect(menuButton).toHaveAccessibleName("Filtry a řazení");
    await menuButton.click();
    await expect(page.locator(".todayOptionsBody select").nth(1)).toBeVisible();
    await page.locator(".todayOptionsBody select").first().selectOption("high");
    await expect(row(page, plain.title)).toHaveCount(0);
    await expect(row(page, high.title)).toBeVisible();
    await page.locator(".todayOptionsBody select").first().selectOption("all");
    await expect(row(page, plain.title)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".todayOptionsBody select").first()).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    // The test instance has no calendar: one quiet sentence with one link, not three mentions.
    await expect(page.locator(".content").getByText("Kalendář není připojen")).toHaveCount(1);
    await expect(page.locator(".todayFooter").getByRole("button", { name: "Připojit" })).toHaveCount(1);
    await expect(page.getByText("Pro spolehlivé časové bloky připojte kalendář")).toHaveCount(0);
    await expect(page.locator(".todayCalendarCommitments")).toHaveCount(0);
  } finally {
    await removeTasks(page, [high.id, plain.id]);
  }
});

test("with more than six tasks Today ends with one Lumi suggestion: Použít moves the task with Undo, Skrýt hides it for the day", async ({ page }) => {
  const id = stamp();
  // Last in the manual order, so the suggestion picks the last of these and no task of another scenario.
  const base = 9e15;
  const tasks = Array.from({ length: 7 }, (_, index) => ({ id: `e2e-d2-full-${id}-${index}`, title: `Plný den ${index + 1} ${id}`, properties: { today: true, manualOrder: base + index } }));
  const last = tasks[6];
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await seedTasks(page, tasks);
  try {
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    const suggestion = page.locator("[data-today-suggestion]");
    await expect(suggestion).toHaveAttribute("data-today-suggestion", last.id);
    await expect(suggestion).toContainText("Lumi:");
    await expect(suggestion).toContainText("Dnešek je plný");
    await expect(suggestion).toContainText(`Přesunout „${last.title}“ na`);
    // Without a fresh calendar the sentence speaks about task counts, never about free time.
    await expect(suggestion).not.toContainText(/volno|volný/i);
    await expect(page.locator("[data-today-suggestion]")).toHaveCount(1);
    await suggestion.getByRole("button", { name: "Použít" }).click();
    await expect(row(page, last.title)).toHaveCount(0);
    const when = (await serverEntities(page)).length; // the page saves; wait for it below
    expect(when).toBeGreaterThan(0);
    await expect.poll(async () => (await serverEntities(page)).find((entity) => entity.id === last.id)?.properties?.when, { timeout: 20_000 }).toBeTruthy();
    // The existing Undo restores the task.
    await page.locator(".undo").getByRole("button").click();
    await expect(row(page, last.title)).toHaveCount(1);
    // Skrýt hides it for the rest of the day, also after a reload.
    await page.locator("[data-today-suggestion]").getByRole("button", { name: "Skrýt" }).click();
    await expect(page.locator("[data-today-suggestion]")).toHaveCount(0);
    await page.reload();
    await waitUntilSynced(page);
    await expect(row(page, last.title)).toBeVisible();
    await expect(page.locator("[data-today-suggestion]")).toHaveCount(0);
  } finally {
    await removeTasks(page, tasks.map((task) => task.id));
  }
});

test("Home: one primary action per attention item, the rest in the ⋯ menu, the evaluation time once, Dnes without attention subjects", async ({ page }) => {
  const id = stamp();
  const overdue = { id: `e2e-d2-over-${id}`, title: `Prošlý termín ${id}` };
  const waiting = { id: `e2e-d2-wait-${id}`, title: `Čeká ${id}` };
  const dueToday = { id: `e2e-d2-both-${id}`, title: `Dnes i po termínu ${id}` };
  const plainToday = { id: `e2e-d2-only-${id}`, title: `Jen dnes ${id}` };
  const ids = [overdue, waiting, dueToday, plainToday].map((task) => task.id);
  await page.goto("/");
  await waitUntilSynced(page);
  const past = await day(page, -3);
  const yesterday = await day(page, -1);
  // Tasks first in the manual order, so they are among the first five of Today and of the attention list.
  const first = -Date.now();
  await seedTasks(page, [
    { ...overdue, properties: { deadline: past } },
    { ...waiting, properties: { waiting: true, waitingFor: "Petr", followUpDate: yesterday } },
    { ...dueToday, properties: { today: true, deadline: past, manualOrder: first } },
    { ...plainToday, properties: { today: true, manualOrder: first + 1 } },
  ]);
  try {
    await page.goto("/");
    await waitUntilSynced(page);
    const more = page.locator(".attentionSection button.textAction", { hasText: "Zobrazit dalších" });
    if (await more.count()) await more.click();
    const item = (title: string) => page.locator(".attentionItem", { hasText: title });

    // A task with a deadline: its date chip is the primary action; Otevřít is in the menu.
    await expect(item(overdue.title)).toBeVisible();
    await expect(item(overdue.title).locator(".deferChip")).toHaveCount(1);
    await expect(item(overdue.title).locator(".attentionOpenAction")).toHaveCount(0);
    // A waiting follow-up: Otevřít is the primary action.
    await expect(item(waiting.title).locator(".attentionOpenAction")).toHaveCount(1);
    await expect(item(waiting.title).locator(".deferChip")).toHaveCount(0);
    // Snooze, dismiss and sources are not on the row; they are in the menu.
    await expect(item(overdue.title).getByRole("menuitem")).toHaveCount(0);
    await item(overdue.title).getByRole("button", { name: /^Další akce/ }).click();
    for (const name of ["Otevřít", "Odložit o 24 h", "Skrýt", "Zdroje"]) await expect(item(overdue.title).getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
    await page.keyboard.press("Escape");

    // One line of reason and source; the evaluation time is in the header once, and in the sources.
    await expect(item(overdue.title).locator(".attentionWhy")).toContainText("uplynul");
    await expect(item(overdue.title).locator(".attentionWhy")).not.toContainText("vyhodnoceno");
    await expect(page.locator(".attentionSection .attentionUpdated")).toHaveCount(1);
    expect(await page.locator(".attentionSection").innerText()).not.toContain("vyhodnoceno");
    await page.locator(".attentionSection .homeSectionHead").getByRole("button", { name: "Obnovit" }).click();
    await expect(page.locator(".attentionSection .attentionUpdated")).toContainText(/Aktualizováno \d{1,2}:\d{2}/);

    // The title opens the subject.
    await item(waiting.title).locator(".attentionTitleButton").click();
    await expect(page.locator("aside.detail")).toHaveAttribute("aria-label", `Úkol: ${waiting.title}`);
    await page.locator("aside.detail button.close").click();

    // Home's Dnes leaves out the task that attention already shows, and counts the same set.
    const todayList = page.locator(".homeToday .homeTaskList article");
    await expect(item(dueToday.title)).toBeVisible();
    await expect(page.locator(".homeToday").getByText(dueToday.title)).toHaveCount(0);
    await expect(page.locator(".homeToday").getByText(plainToday.title)).toHaveCount(1);
    expect(await todayList.count()).toBeLessThanOrEqual(5);
    const today = await day(page, 0);
    const counts = await page.evaluate(async (todayValue) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const attention = await fetch("/api/attention?workspaceId=personal", { cache: "no-store" }).then((response) => response.json());
      const subjects = new Set(attention.items.map((entry: { subjectId: string }) => entry.subjectId));
      const inToday = snapshot.entities.filter((entity: { type: string; status: string; workspaceId: string; properties?: Record<string, unknown> }) =>
        entity.type === "task" && entity.status === "open" && entity.workspaceId === "personal" &&
        (entity.properties?.today === true || (typeof entity.properties?.when === "string" && entity.properties.when !== "" && entity.properties.when <= todayValue)));
      return inToday.filter((entity: { id: string }) => !subjects.has(entity.id)).length;
    }, today);
    const shown = await todayList.count();
    const rest = page.locator(".homeToday > .textAction");
    if (counts > 5) await expect(rest).toContainText(`a dalších ${counts - shown} na dnešek`);
    else await expect(rest).toHaveCount(0);

    // No calendar: one quiet line with the one link to connect it, not three mentions.
    await expect(page.locator(".content").getByText("Kalendář není připojen")).toHaveCount(1);
    await expect(page.locator(".content").getByRole("button", { name: "Připojit" })).toHaveCount(1);
    await expect(page.getByText("Pro spolehlivé časové bloky připojte kalendář")).toHaveCount(0);

    // Snooze from the menu keeps working: the item leaves the list.
    await item(waiting.title).getByRole("button", { name: /^Další akce/ }).click();
    await item(waiting.title).getByRole("menuitem", { name: /^Odložit o 24 h/ }).click();
    await expect(item(waiting.title)).toHaveCount(0);
  } finally {
    await removeTasks(page, ids);
  }
});

test.describe("on a 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Home items keep 44px targets, the + button never covers an action and nothing scrolls sideways", async ({ page }) => {
    const id = stamp();
    const overdue = { id: `e2e-d2-m-over-${id}`, title: `Mobil prošlý termín ${id}` };
    const waiting = { id: `e2e-d2-m-wait-${id}`, title: `Mobil čeká ${id}` };
    await page.goto("/");
    await waitUntilSynced(page);
    await seedTasks(page, [
      { ...overdue, properties: { deadline: await day(page, -3) } },
      { ...waiting, properties: { waiting: true, waitingFor: "Petr", followUpDate: await day(page, -1) } },
    ]);
    try {
      await page.goto("/");
      await waitUntilSynced(page);
      const more = page.locator(".attentionSection button.textAction", { hasText: "Zobrazit dalších" });
      if (await more.count()) await more.click();
      const fab = page.locator(".mobileCaptureButton");
      await expect(fab).toBeVisible();
      for (const title of [overdue.title, waiting.title]) {
        const item = page.locator(".attentionItem", { hasText: title });
        await item.scrollIntoViewIfNeeded();
        const targets = item.locator(".deferChip, .attentionOpenAction, .attentionMenuButton, .attentionTitleButton");
        for (let index = 0; index < await targets.count(); index += 1) {
          const target = targets.nth(index);
          await target.scrollIntoViewIfNeeded();
          const box = (await target.boundingBox())!;
          expect(box.height, `${title} target ${index} height`).toBeGreaterThanOrEqual(43.5);
          const covered = (await fab.boundingBox())!;
          const overlaps = box.x < covered.x + covered.width && box.x + box.width > covered.x && box.y < covered.y + covered.height && box.y + box.height > covered.y;
          expect(overlaps, `${title} target ${index} is under the + button`).toBe(false);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The menu is a sheet inside the screen.
      await page.locator(".attentionItem", { hasText: overdue.title }).getByRole("button", { name: /^Další akce/ }).click();
      const sheet = page.locator(".popoverMenuPanel");
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await page.keyboard.press("Escape");
    } finally {
      await removeTasks(page, [overdue.id, waiting.id]);
    }
  });

  test("Today: the time cell and the ⋯ button are 44px targets and nothing scrolls sideways", async ({ page }) => {
    const id = stamp();
    const task = { id: `e2e-d2-m-today-${id}`, title: `Mobil dnes ${id}` };
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    await seedTasks(page, [{ ...task, properties: { today: true } }]);
    try {
      await page.goto("/?view=Today");
      await waitUntilSynced(page);
      const cell = row(page, task.title).locator("[data-time-cell]");
      await expect(cell).toBeVisible();
      for (const target of [cell, page.locator("[data-today-menu]")]) {
        const box = (await target.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(43.5);
        expect(box.width).toBeGreaterThanOrEqual(43.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await cell.click();
      const box = (await page.locator(`[data-time-menu="${task.id}"]`).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const action = await page.locator(`[data-time-menu="${task.id}"]`).getByRole("button", { name: "Zítra" }).boundingBox();
      expect(action!.height).toBeGreaterThanOrEqual(43.5);
    } finally {
      await removeTasks(page, [task.id]);
    }
  });
});
