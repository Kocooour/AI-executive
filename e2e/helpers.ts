import { expect, type Page } from "@playwright/test";
import { e2ePassword } from "../playwright.config";

export const seeded = {
  project: "Projekt Alfa",
  overdueTask: "Zaplatit fakturu",
  plainTask: "Zavolat instalatérovi",
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
  return page.locator(".pageTitleRow h1");
}

export async function waitForSync(page: Page) {
  await expect(page.locator(".homeSync, .syncState").first()).toBeAttached({ timeout: 15_000 }).catch(() => undefined);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-executive-pending-sync")), { timeout: 15_000 }).toBeNull();
}

export function serverEntities(page: Page) {
  return page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json()).then((snapshot) => snapshot.entities as Array<{ id: string; type: string; title: string; status: string }>));
}
