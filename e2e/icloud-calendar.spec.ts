import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { caldavMockPort } from "../playwright.config";
import { mockAppleId, startCalDavMock, type CalDavMock } from "./caldav-mock";
import { confirmDialog, settingsSections, waitUntilSynced } from "./helpers";

// iCloud calendar over CalDAV, read-only, against a local mock of iCloud (e2e/caldav-mock.ts). The scenarios build on each
// other in file order: connect, a refused password and its recovery, disconnect, ICS alongside, the phone layout.

const firstPassword = "abcd-efgh-ijkl-mnop";
const secondPassword = "qrst-uvwx-yzab-cdef";
let mock: CalDavMock;
let otherWorkspaceId = "";

test.beforeAll(async () => { mock = await startCalDavMock(caldavMockPort, firstPassword); });
test.afterAll(async () => { await mock?.close(); });

async function openCalendarSettings(page: Page) {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Kalendář" }).click();
  const block = page.locator(".icloudCalendar");
  await expect(block.getByRole("heading", { name: "Kalendář iCloud · pouze pro čtení" })).toBeVisible();
  return block;
}

const accountState = (page: Page) => page.evaluate(() => fetch("/api/calendar/icloud", { cache: "no-store" }).then((response) => response.json()));
const calendarEvents = (page: Page, workspaceId: string) => page.evaluate(async (id) => {
  const now = Date.now();
  const response = await fetch(`/api/calendar?workspaceId=${encodeURIComponent(id)}&from=${now - 86_400_000}&to=${now + 14 * 86_400_000}`, { cache: "no-store" });
  return (await response.json()) as { sources: Array<{ provider: string; status: string }>; events: Array<{ title: string }> };
}, workspaceId);

/** Everything the browser keeps: local and session storage and every IndexedDB store. */
const browserStorage = (page: Page) => page.evaluate(async () => {
  const parts = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(info.name!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const name of Array.from(database.objectStoreNames)) {
      parts.push(JSON.stringify(await new Promise((resolve) => {
        const request = database.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      })));
    }
    database.close();
  }
  return parts.join("\n");
});

async function connect(page: Page, block: ReturnType<Page["locator"]>, password: string, workspaces: Record<string, string> = {}) {
  await block.getByLabel("Apple ID").fill(mockAppleId);
  await block.getByLabel("Heslo pro aplikace").fill(password);
  await block.getByRole("button", { name: "Najít kalendáře" }).click();
  await expect(block.getByRole("checkbox", { name: "Domov" })).toBeChecked();
  for (const [name, workspaceId] of Object.entries(workspaces)) await block.getByLabel(`Workspace pro ${name}`).selectOption(workspaceId);
  await block.getByRole("button", { name: "Připojit" }).click();
  await expect(block.getByText("Kalendáře iCloud jsou připojené pouze pro čtení.")).toBeVisible({ timeout: 20_000 });
}

test("iCloud: a refused password stores nothing; connecting reads the chosen calendars into their workspaces", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  otherWorkspaceId = await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const workspaceId = `e2e-icloud-work-${now}`;
    const workspace = { id: `workspace:${workspaceId}`, type: "workspace", title: "Práce iCloud", status: "active", workspaceId,
      properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now };
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: [...snapshot.entities, workspace],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    if (!response.ok) throw new Error(`Could not seed a workspace: ${response.status}`);
    return workspaceId;
  });
  const block = await openCalendarSettings(page);
  await expect(block.getByRole("link", { name: /Otevřít Apple účet/ })).toHaveAttribute("rel", "noopener noreferrer");
  const passwordField = block.getByLabel("Heslo pro aplikace");
  await expect(passwordField).toHaveAttribute("type", "password");
  await expect(passwordField).toHaveAttribute("autocomplete", "off");

  // A wrong password: Apple's refusal is shown and nothing is stored.
  await block.getByLabel("Apple ID").fill(mockAppleId);
  await passwordField.fill("wxyz-wxyz-wxyz-wxyz");
  await block.getByRole("button", { name: "Najít kalendáře" }).click();
  await expect(block.getByRole("alert")).toContainText("Apple heslo pro aplikace odmítl");
  expect((await accountState(page)).account).toBeNull();

  // The right one: the event calendars are offered (not the reminders list), each with a workspace.
  await passwordField.fill(firstPassword);
  await block.getByRole("button", { name: "Najít kalendáře" }).click();
  await expect(block.getByRole("checkbox", { name: "Práce" })).toBeVisible();
  await expect(block.getByRole("checkbox", { name: "Připomínky" })).toHaveCount(0);
  await block.getByLabel("Workspace pro Práce").selectOption(otherWorkspaceId);
  await block.getByRole("button", { name: "Připojit" }).click();
  await expect(block.getByText("Kalendáře iCloud jsou připojené pouze pro čtení.")).toBeVisible({ timeout: 20_000 });
  await expect(block.locator(".icloudAccountLine")).toContainText("j***@icloud.com");
  await expect(block.locator(".icloudAccountLine")).toContainText("synchronizováno");
  await expect(block.locator(".calendarSources")).toContainText("Domov");
  await expect(block.locator(".calendarSources")).toContainText("Práce iCloud");
  // Counts in the right Czech form: Domov has two occurrences of the weekly meeting and the private event.
  await expect(block.locator(".calendarSources > div", { hasText: "Domov" })).toContainText("3 události");
  await expect(block.locator(".calendarSources > div", { hasText: "Práce" })).toContainText("1 událost");
  await expect(block.locator(".calendarSources")).not.toContainText("událostí");
  await expect(block.getByLabel("Heslo pro aplikace")).toHaveCount(0);

  // Neither the password nor the Apple ID is kept in the browser or returned by the server.
  const stored = await browserStorage(page);
  for (const secret of [firstPassword, firstPassword.replace(/-/g, ""), mockAppleId]) expect(stored).not.toContain(secret);
  const state = JSON.stringify(await accountState(page));
  for (const secret of [firstPassword, mockAppleId, "127.0.0.1", "9876543210"]) expect(state).not.toContain(secret);

  // The Calendar shows the personal events with a fresh state; the other calendar went to its workspace.
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  const view = page.locator(".calendarView");
  await expect(view).toContainText("Týdenní porada iCloud");
  await expect(view).toContainText("Soukromá událost");
  await expect(view).not.toContainText("Tajná schůzka");
  await expect(view).not.toContainText("Schůzka s klientem iCloud");
  await expect(view.getByRole("status").first()).toContainText("h volno");
  expect((await calendarEvents(page, otherWorkspaceId)).events.map((event) => event.title)).toContain("Schůzka s klientem iCloud");
});

test("iCloud: a refused password stops reading until a new app-specific password is entered", async ({ page }) => {
  mock.setPassword(secondPassword);
  const block = await openCalendarSettings(page);
  await block.getByRole("button", { name: "Obnovit" }).click();
  await expect(block.locator(".icloudAccountLine")).toContainText("Apple heslo odmítl", { timeout: 20_000 });
  await expect(block.getByRole("button", { name: "Obnovit" })).toHaveCount(0);
  expect((await accountState(page)).account.status).toBe("auth_failed");
  // Planning no longer claims free time from it.
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await expect(page.locator(".calendarView").getByRole("status").first()).toContainText("Kapacita neověřena");

  const again = await openCalendarSettings(page);
  await again.getByRole("button", { name: "Změnit heslo" }).click();
  await again.getByLabel("Nové heslo pro aplikace").fill(secondPassword);
  await again.getByRole("button", { name: "Uložit heslo" }).click();
  await expect(again.getByText("Nové heslo funguje; kalendáře se načítají znovu.")).toBeVisible({ timeout: 20_000 });
  await expect(again.locator(".icloudAccountLine")).toContainText("synchronizováno");
  await expect(again.getByLabel("Nové heslo pro aplikace")).toHaveCount(0);
  expect(await browserStorage(page)).not.toContain(secondPassword);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await expect(page.locator(".calendarView").getByRole("status").first()).toContainText("h volno");
});

test("iCloud: disconnecting removes its events and planning falls back to no calendar", async ({ page }) => {
  const block = await openCalendarSettings(page);
  await block.getByRole("button", { name: "Odpojit" }).click();
  await expect(confirmDialog(page)).toContainText("Odpojit iCloud?");
  await confirmDialog(page).getByRole("button", { name: "Odpojit" }).click();
  await expect(block.getByText("iCloud byl odpojen a jeho události odstraněny.")).toBeVisible();
  expect((await accountState(page)).account).toBeNull();
  expect((await calendarEvents(page, "personal")).events).toEqual([]);
  expect((await calendarEvents(page, otherWorkspaceId)).events).toEqual([]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await expect(page.locator(".calendarView").getByRole("status").first()).toContainText("Kalendář není připojen");
});

test("iCloud: an ICS calendar keeps working next to it and stays when iCloud is disconnected", async ({ page }) => {
  // An ICS source with a cached event, as a fetched feed leaves it (the test instance cannot reach an outside feed).
  const live = new DatabaseSync(path.join(process.env.LUMI_E2E_RUN_DIR!, "data", "store.sqlite"));
  const now = Date.now();
  const start = now + 26 * 60 * 60_000;
  try {
    live.prepare(`INSERT INTO calendar_sources (id, workspace_id, provider, label, encrypted_url, status, last_sync_at, last_success_at, event_count, revision, created_at, updated_at)
      VALUES ('e2e-ics', 'personal', 'ics', 'Feed ICS e2e', 'not-used', 'ready', ?, ?, 1, 1, ?, ?)`).run(now, now, now, now);
    const payload = { id: "e2e-ics-event", sourceId: "e2e-ics", workspaceId: "personal", uid: "ics-1", occurrenceKey: `ics-1:${new Date(start).toISOString()}`,
      title: "Událost z ICS e2e", start: new Date(start).toISOString(), end: new Date(start + 60 * 60_000).toISOString(), allDay: false, timezone: "UTC",
      status: "CONFIRMED", transparency: "OPAQUE", busy: true, private: false };
    live.prepare(`INSERT INTO calendar_events (id, source_id, workspace_id, occurrence_key, payload, start_at, end_at, updated_at) VALUES (?, 'e2e-ics', 'personal', ?, ?, ?, ?, ?)`)
      .run(payload.id, payload.occurrenceKey, JSON.stringify(payload), start, start + 60 * 60_000, now);
  } finally { live.close(); }

  mock.setPassword(firstPassword);
  const block = await openCalendarSettings(page);
  await connect(page, block, firstPassword);
  // The ICS list shows the feed only; the iCloud calendars are managed in their own block.
  const section = page.locator(".settingsPanel section:not([hidden])");
  const icsList = section.locator(":scope > .calendarSources");
  await expect(icsList).toContainText("Feed ICS e2e");
  await expect(icsList).not.toContainText("Domov");

  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  const view = page.locator(".calendarView");
  await expect(view).toContainText("Událost z ICS e2e");
  await expect(view).toContainText("Týdenní porada iCloud");

  const again = await openCalendarSettings(page);
  await again.getByRole("button", { name: "Odpojit" }).click();
  await confirmDialog(page).getByRole("button", { name: "Odpojit" }).click();
  await expect(again.getByText("iCloud byl odpojen a jeho události odstraněny.")).toBeVisible();
  const personal = await calendarEvents(page, "personal");
  expect(personal.events.map((event) => event.title)).toEqual(["Událost z ICS e2e"]);
  expect(personal.sources.map((source) => source.provider)).toEqual(["ics"]);

  // Clean up through the ICS row's own action.
  const icsRow = page.locator(".settingsPanel section:not([hidden]) > .calendarSources > div", { hasText: "Feed ICS e2e" });
  await icsRow.getByRole("button", { name: "Odpojit" }).click();
  await confirmDialog(page).getByRole("button", { name: "Odpojit" }).click();
  await expect.poll(async () => (await calendarEvents(page, "personal")).sources.length).toBe(0);
});

test.describe("on a phone-sized screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("iCloud: the calendar settings fit 390 px with 44 px targets", async ({ page }) => {
    mock.setPassword(firstPassword);
    const block = await openCalendarSettings(page);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    await block.getByLabel("Apple ID").fill(mockAppleId);
    await block.getByLabel("Heslo pro aplikace").fill(firstPassword);
    await block.getByRole("button", { name: "Najít kalendáře" }).click();
    await expect(block.getByRole("checkbox", { name: "Práce" })).toBeVisible();
    expect(await fits()).toBe(true);
    const targets = block.locator("button, select, label.icloudCheck, input[type=email], input[type=password]");
    const count = await targets.count();
    expect(count).toBeGreaterThan(4);
    for (let index = 0; index < count; index += 1) {
      const box = await targets.nth(index).boundingBox();
      expect(box, `target ${index}`).not.toBeNull();
      expect(box!.height, `target ${index} height`).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width, `target ${index} right edge`).toBeLessThanOrEqual(390);
    }
    // Cancel leaves nothing behind: no account, the password field is empty.
    await block.getByRole("button", { name: "Zrušit" }).click();
    await expect(block.getByLabel("Heslo pro aplikace")).toHaveValue("");
    expect((await accountState(page)).account).toBeNull();
  });
});
