import { expect, type Page } from "@playwright/test";
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
// Wait until that has settled and nothing is waiting to be sent.
export async function waitUntilSynced(page: Page) {
  await expect.poll(() => page.evaluate(() => [localStorage.getItem("ai-executive-server-synced"), localStorage.getItem("ai-executive-pending-sync")]),
    { timeout: 20_000 }).toEqual(["1", null]);
}

export function serverEntities(page: Page) {
  return page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json()).then((snapshot) => snapshot.entities as Array<{ id: string; type: string; title: string; status: string }>));
}

// The server copy is the proof that a change was sent.
export async function expectOnServer(page: Page, match: (entity: { id: string; title: string }) => boolean, present: boolean) {
  await expect.poll(async () => (await serverEntities(page)).some(match), { timeout: 20_000 }).toBe(present);
}
