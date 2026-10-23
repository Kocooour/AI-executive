import { expect, type Page, type Request } from "@playwright/test";
import { e2ePassword } from "../playwright.config";

export const seeded = {
  project: "Projekt Alfa",
  overdueTask: "Zaplatit fakturu",
  plainTask: "Zavolat instalatérovi",
  renameTask: "Objednat revizi kotle",
};

export async function signIn(page: Page) {
  await page.locator('.authCard input[type="password"]').fill(e2ePassword);
  await page.keyboard.press("Enter");
  await expect(page.locator(".appShell")).toBeVisible();
}

// The sidebar entry of a view, by its Czech label.
export function sidebarView(page: Page, label: string) {
  return page.locator("button:has(.navLabel)", { hasText: label }).first();
}

// A primary navigation entry on either layout: the sidebar on desktop, the bottom bar on a phone.
export function navView(page: Page, view: string) {
  return page.locator(`[data-nav-view="${view}"]:visible`).first();
}

// Settings from anywhere, without reloading the page: the footer button of the sidebar, or More on a phone.
export async function openSettings(page: Page) {
  const more = page.locator('.mobileNav button[data-nav-view="More"]');
  if (await more.isVisible()) {
    await more.click();
    await page.locator('.mobileMoreItem[data-nav-view="Settings"]').click();
  } else {
    await page.locator("aside .sidebarActions > button").last().click();
  }
}

// Inbox -> "Z pošty": the mail reader of the connected Gmail accounts (it moved there from Settings).
export async function openMailReader(page: Page) {
  await navView(page, "Inbox").click();
  await page.locator('[data-inbox-tab="mail"]').click();
  const reader = page.locator(".mailReader");
  await expect(reader).toBeVisible();
  return reader;
}

export function heading(page: Page) {
  return page.getByRole("heading", { level: 1 });
}

export function confirmDialog(page: Page) {
  return page.locator("dialog.confirmDialog");
}

export function settingsSections(page: Page) {
  return page.getByRole("navigation", { name: "Sekce nastavení" }).getByRole("button");
}

// Every scenario starts with an empty browser, so the app first takes the server copy.
// Wait until that has settled, nothing is waiting to be sent and the loads that follow it
// (attention, day plan) are finished: a scenario that ends the session next would otherwise
// have one of those refused first.
export async function waitUntilSynced(page: Page) {
  await expect.poll(() => page.evaluate(() => [localStorage.getItem("ai-executive-server-synced"), localStorage.getItem("ai-executive-pending-sync")]),
    { timeout: 20_000 }).toEqual(["1", null]);
  await waitUntilQuiet(page);
}

// Waits until the page has had no request in flight for `quietMs`. A request that was already
// running when this starts is not known here; its end still counts as activity.
export async function waitUntilQuiet(page: Page, quietMs = 500) {
  const inFlight = new Set<Request>();
  let lastChange = Date.now();
  const started = (request: Request) => { inFlight.add(request); lastChange = Date.now(); };
  const ended = (request: Request) => { inFlight.delete(request); lastChange = Date.now(); };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  try {
    await expect.poll(() => inFlight.size === 0 && Date.now() - lastChange >= quietMs, { timeout: 20_000, intervals: [100] }).toBe(true);
  } finally {
    page.off("request", started);
    page.off("requestfinished", ended);
    page.off("requestfailed", ended);
  }
}

export function serverEntities(page: Page) {
  return page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json()).then((snapshot) => snapshot.entities as Array<{ id: string; type: string; title: string; status: string; properties?: Record<string, unknown> }>));
}

// The server copy is the proof that a change was sent.
export async function expectOnServer(page: Page, match: (entity: { id: string; title: string; properties?: Record<string, unknown> }) => boolean, present: boolean) {
  await expect.poll(async () => (await serverEntities(page)).some(match), { timeout: 20_000 }).toBe(present);
}

// Adds tasks straight to the server store, as another device would (with the restore generation, since
// other specs restore backups), retrying when a save of the open page takes the revision first.
export async function seedTasks(page: Page, tasks: Array<{ id: string; title: string; properties: Record<string, unknown> }>) {
  await expect.poll(() => page.evaluate(async (newTasks) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
      entities: [...snapshot.entities, ...newTasks.map((task) => ({ ...task, type: "task", status: "open", workspaceId: "personal", createdAt: now, updatedAt: now }))],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    return response.status;
  }, tasks), { timeout: 15_000 }).toBe(200);
}

// Removes tasks from the server store again, so a scenario that seeded dated tasks leaves nothing that
// pushes items out of Home for the scenarios after it (the instance is shared).
export async function removeTasks(page: Page, ids: string[]) {
  await expect.poll(() => page.evaluate(async (gone) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
      entities: snapshot.entities.filter((row: { id: string }) => !gone.includes(row.id)), relations: snapshot.relations, deletedIds: gone, revivedIds: [] }) });
    return response.status;
  }, ids), { timeout: 15_000 }).toBe(200);
}
