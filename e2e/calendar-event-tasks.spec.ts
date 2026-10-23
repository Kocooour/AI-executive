import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectOnServer, removeTasks, seedTasks, serverEntities, waitUntilSynced } from "./helpers";

// Calendar events the owner decides about: hide (this one or the whole series; it still occupies time),
// "Je to úkol?" (Ano makes a task with the event's length, Ne stops asking), and Lumi's one suggestion
// when the day is then full. The calendar is a fixed mock of /api/calendar (no iCloud/ICS source is
// needed); decisions and tasks go through the real local-first/sync path. Everything created is removed
// again: the instance is shared.

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const dayOffset = (page: Page, offset: number) => page.evaluate((days) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}, offset);

type MockEvent = { id: string; uid: string; title: string; start: string; end: string };
async function mockCalendar(page: Page, events: MockEvent[]) {
  const now = Date.now();
  await page.route("**/api/calendar?**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      sources: [{ id: "e2e-src", workspaceId: "personal", provider: "ics", accountId: null, label: "E2E", status: "ready", configured: true, lastSyncAt: now, lastSuccessAt: now, lastError: "", eventCount: events.length, revision: 1 }],
      events: events.map((event) => ({ ...event, sourceId: "e2e-src", workspaceId: "personal", occurrenceKey: `${event.uid}:${event.start}`, allDay: false, timezone: "Europe/Prague", status: "confirmed", transparency: "OPAQUE", busy: true, private: false })),
    }) });
  });
}

// The decisions the instance holds; removed again so nothing is left for the scenarios after this one.
async function clearDecisions(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const entities = snapshot.entities.map((row: { id: string; properties: Record<string, unknown>; updatedAt: number }) => {
      if (row.id !== "workspace:personal" || !row.properties.calendarDecisions) return row;
      const { calendarDecisions: _gone, ...properties } = row.properties;
      return { ...row, properties, updatedAt: Math.max(now, row.updatedAt + 1) };
    });
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
      entities, relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    return response.status;
  }), { timeout: 15_000 }).toBe(200);
}
const decisionsOnServer = async (page: Page) => (await serverEntities(page)).find((entity) => entity.id === "workspace:personal")?.properties?.calendarDecisions as Record<string, string> | undefined;
const card = (page: Page, title: string) => page.locator(".calendarAgendaItem", { hasText: title });

test("hide: a single event hides at once with Undo, a recurring one asks, hidden events can be shown again", async ({ page }) => {
  const id = stamp();
  const day = await dayOffset(page, 2);
  const single: MockEvent = { id: `e2e-ev-${id}-a`, uid: `single-${id}`, title: `Jednorázová schůzka ${id}`, start: `${day}T08:00:00.000Z`, end: `${day}T08:30:00.000Z` };
  const first: MockEvent = { id: `e2e-ev-${id}-b`, uid: `series-${id}`, title: `Opakovaná porada ${id}`, start: `${day}T09:00:00.000Z`, end: `${day}T09:30:00.000Z` };
  const next: MockEvent = { ...first, id: `e2e-ev-${id}-c`, start: `${day}T10:00:00.000Z`, end: `${day}T10:30:00.000Z` };
  await mockCalendar(page, [single, first, next]);
  try {
    await page.goto("/?view=Calendar");
    await waitUntilSynced(page);
    await expect(card(page, single.title)).toBeVisible();

    // A single event: one press hides it; it is not listed, but the footer counts it.
    const hide = page.getByRole("button", { name: `Skrýt událost: ${single.title}` });
    await expect(hide).toHaveAttribute("data-event-hide", single.id);
    await hide.click();
    await expect(card(page, single.title)).toHaveCount(0);
    await expect(page.locator("[data-hidden-events]")).toContainText("Skryté události: 1");
    await expectOnServer(page, (entity) => Boolean((entity.properties?.calendarDecisions as Record<string, string> | undefined)?.[`occ:e2e-src:${single.uid}:${single.start}`]), true);
    expect(JSON.stringify(await decisionsOnServer(page))).not.toContain("Jednorázová");

    // Undo puts it back.
    await page.locator(".undo").getByRole("button", { name: "Zpět" }).click();
    await expect(card(page, single.title)).toBeVisible();
    await expect(page.locator("[data-hidden-events]")).toHaveCount(0);

    // A recurring event asks: only this one, or every repeat.
    await page.getByRole("button", { name: `Skrýt událost: ${first.title}` }).first().click();
    await page.getByRole("menuitem", { name: "Jen tuto" }).click();
    await expect(card(page, first.title)).toHaveCount(1);
    await expect(page.locator("[data-hidden-events]")).toContainText("Skryté události: 1");
    await page.getByRole("button", { name: `Skrýt událost: ${first.title}` }).first().click();
    await page.getByRole("menuitem", { name: "Všechna opakování" }).click();
    await expect(card(page, first.title)).toHaveCount(0);
    await expect(page.locator("[data-hidden-events]")).toContainText("Skryté události: 2");
    await expectOnServer(page, (entity) => Boolean((entity.properties?.calendarDecisions as Record<string, string> | undefined)?.[`series:e2e-src:${first.uid}`]), true);

    // The footer shows them again and un-hides one.
    await page.locator("[data-hidden-events]").getByRole("button", { name: "Zobrazit" }).click();
    await page.getByRole("button", { name: `Zobrazit znovu událost: ${first.title}` }).first().click();
    await expect(card(page, first.title).first()).toBeVisible();
  } finally {
    await clearDecisions(page);
  }
});

test("Je to úkol?: Ne stops asking, Ano makes a task with the event's length and the event then links to it", async ({ page }) => {
  const id = stamp();
  const day = await dayOffset(page, 3);
  const asked: MockEvent = { id: `e2e-ev-${id}-1`, uid: `ask-${id}`, title: `Schůzka s klientem ${id}`, start: `${day}T12:00:00.000Z`, end: `${day}T12:45:00.000Z` };
  const refused: MockEvent = { id: `e2e-ev-${id}-2`, uid: `no-${id}`, title: `Oběd ${id}`, start: `${day}T10:00:00.000Z`, end: `${day}T11:00:00.000Z` };
  await mockCalendar(page, [asked, refused]);
  const taskIds: string[] = [];
  try {
    await page.goto("/?view=Calendar");
    await waitUntilSynced(page);

    await card(page, refused.title).getByRole("button", { name: `Událost ${refused.title} není úkol` }).click();
    await expect(card(page, refused.title)).toBeVisible();
    await expect(card(page, refused.title).locator("[data-event-answer]")).toHaveCount(0);

    await expect(card(page, asked.title).getByText("Je to úkol?")).toBeVisible();
    await card(page, asked.title).getByRole("button", { name: `Vytvořit úkol z události ${asked.title}` }).click();
    await expect(card(page, asked.title).locator(".calendarEventTask")).toContainText(`Úkol: ${asked.title}`);
    await expect(card(page, asked.title).locator("[data-event-answer]")).toHaveCount(0);
    await expectOnServer(page, (entity) => entity.title === asked.title && entity.properties?.calendarEventId === asked.id, true);
    const task = (await serverEntities(page)).find((entity) => entity.title === asked.title && entity.properties?.calendarEventId === asked.id)!;
    taskIds.push(task.id);
    expect(task.properties).toMatchObject({ estimatedMinutes: 45, when: day, calendarEventKey: `${asked.uid}:${asked.start}`, calendarSourceId: "e2e-src" });
    expect(task.properties?.deadline).toBeUndefined();

    // The answer survives a reload and no question is asked again.
    await page.reload();
    await waitUntilSynced(page);
    await expect(card(page, asked.title).locator(".calendarEventTask")).toBeVisible();
    await expect(card(page, refused.title).locator("[data-event-answer]")).toHaveCount(0);

    // Undo of a creation removes the task again (here: a second event, then Undo).
    const third: MockEvent = { id: `e2e-ev-${id}-3`, uid: `undo-${id}`, title: `Krátká věc ${id}`, start: `${day}T13:00:00.000Z`, end: `${day}T13:20:00.000Z` };
    await page.unroute("**/api/calendar?**");
    await mockCalendar(page, [asked, refused, third]);
    await page.reload();
    await waitUntilSynced(page);
    await card(page, third.title).getByRole("button", { name: `Vytvořit úkol z události ${third.title}` }).click();
    await expectOnServer(page, (entity) => entity.title === third.title, true);
    await page.locator(".undo").getByRole("button", { name: "Zpět" }).click();
    await expectOnServer(page, (entity) => entity.title === third.title, false);
    await expect(card(page, third.title).locator("[data-event-answer='yes']")).toBeVisible();
  } finally {
    if (taskIds.length) await removeTasks(page, taskIds);
    const leftovers = (await serverEntities(page)).filter((entity) => id && entity.title.includes(id) && entity.type === "task").map((entity) => entity.id);
    if (leftovers.length) await removeTasks(page, leftovers);
    await clearDecisions(page);
  }
});

test("a full day: after Ano Lumi proposes moving the least important task and applies it with one press", async ({ page }) => {
  const id = stamp();
  const day = await dayOffset(page, 4);
  const after = await dayOffset(page, 5);
  const event: MockEvent = { id: `e2e-ev-${id}-f`, uid: `full-${id}`, title: `Workshop ${id}`, start: `${day}T08:00:00.000Z`, end: `${day}T16:00:00.000Z` };
  const keep = { id: `e2e-cal-keep-${id}`, title: `Důležitý úkol ${id}`, properties: { when: day, priority: "high", estimatedMinutes: 240 } };
  const movable = { id: `e2e-cal-move-${id}`, title: `Odložitelný úkol ${id}`, properties: { when: day, estimatedMinutes: 180 } };
  await mockCalendar(page, [event]);
  try {
    await page.goto("/?view=Calendar");
    await waitUntilSynced(page);
    await seedTasks(page, [keep, movable]);
    await page.reload();
    await waitUntilSynced(page);
    await card(page, event.title).getByRole("button", { name: `Vytvořit úkol z události ${event.title}` }).click();
    const line = card(page, event.title).locator("[data-event-suggestion]");
    await expect(line).toContainText(`Lumi navrhuje posunout ${movable.title}`);
    await expect(line).toContainText("protože den je plný");
    await line.getByRole("button", { name: "Posunout" }).click();
    await expect(line).toHaveCount(0);
    await expectOnServer(page, (entity) => entity.id === movable.id && entity.properties?.when === after, true);
    await expectOnServer(page, (entity) => entity.id === keep.id && entity.properties?.when === day, true);
  } finally {
    const created = (await serverEntities(page)).filter((entity) => entity.type === "task" && entity.title.includes(id)).map((entity) => entity.id);
    await removeTasks(page, [...new Set([keep.id, movable.id, ...created])]);
    await clearDecisions(page);
  }
});
