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
