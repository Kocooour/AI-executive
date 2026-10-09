import { expect, test } from "./fixtures";
import type { Browser, Page } from "@playwright/test";
import { sessionFile } from "../playwright.config";
import { expectOnServer, serverEntities, waitUntilSynced } from "./helpers";

// Two devices of the same owner edit one task while one of them is offline. The device that was
// offline merges field by field when it is back (lib/field-merge.ts).
async function device(browser: Browser) {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  return { context, page: await context.newPage() };
}

async function newTask(page: Page, title: string) {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const field = page.locator(".capture input");
  await field.fill(title);
  await field.press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  return id;
}

async function editNotes(page: Page, text: string) {
  await page.getByLabel("Poznámky k úkolu").fill(text);
  await page.locator("input.titleEdit").focus();
}

test("two devices changing different fields of one task both keep their change", async ({ browser }) => {
  const laptop = await device(browser), phone = await device(browser);
  const title = `Dvě zařízení ${Date.now()}`;
  const id = await newTask(laptop.page, title);
  await phone.page.goto(`/?task=${id}`);
  await waitUntilSynced(phone.page);
  // The phone loses its connection and changes the notes; meanwhile the laptop renames the task.
  await phone.context.setOffline(true);
  await editNotes(phone.page, "Poznámka z telefonu");
  await laptop.page.goto(`/?task=${id}`);
  await waitUntilSynced(laptop.page);
  const renamed = `${title} (přejmenováno)`;
  await laptop.page.locator("input.titleEdit").fill(renamed);
  await laptop.page.getByLabel("Poznámky k úkolu").focus();
  await expectOnServer(laptop.page, (entity) => entity.id === id && entity.title === renamed, true);
  await phone.context.setOffline(false);
  await expectOnServer(laptop.page, (entity) => entity.id === id && entity.title === renamed && entity.properties?.notes === "Poznámka z telefonu", true);
  const saved = (await serverEntities(laptop.page)).find((entity) => entity.id === id);
  expect(saved?.properties?.syncConflicts ?? []).toEqual([]);
  await laptop.context.close();
  await phone.context.close();
});

test("the same field changed on two devices keeps the newer value and offers to restore the other", async ({ browser }) => {
  const laptop = await device(browser), phone = await device(browser);
  const id = await newTask(laptop.page, `Stejné pole ${Date.now()}`);
  await phone.page.goto(`/?task=${id}`);
  await waitUntilSynced(phone.page);
  await phone.context.setOffline(true);
  await editNotes(phone.page, "Starší z telefonu");
  // The laptop's change comes later, so it is the newer one.
  await laptop.page.goto(`/?task=${id}`);
  await waitUntilSynced(laptop.page);
  await editNotes(laptop.page, "Novější z počítače");
  await expectOnServer(laptop.page, (entity) => entity.id === id && entity.properties?.notes === "Novější z počítače", true);
  await phone.context.setOffline(false);
  await expectOnServer(laptop.page, (entity) => entity.id === id && Array.isArray(entity.properties?.syncConflicts) && (entity.properties?.syncConflicts as unknown[]).length === 1, true);
  const saved = (await serverEntities(laptop.page)).find((entity) => entity.id === id);
  expect(saved?.properties?.notes).toBe("Novější z počítače");

  // The laptop sees the replaced value on the task and in the list, and restores it.
  await laptop.page.goto("/?view=Inbox");
  await waitUntilSynced(laptop.page);
  await expect(laptop.page.locator(".conflictMark").first()).toBeVisible();
  await laptop.page.goto(`/?task=${id}`);
  await waitUntilSynced(laptop.page);
  const section = laptop.page.locator(".syncConflicts");
  await expect(section).toContainText("Změna z jiného zařízení");
  await expect(section).toContainText("Poznámky");
  await expect(section).toContainText("Starší z telefonu");
  await section.getByRole("button", { name: "Vrátit" }).click();
  await expect(section).toHaveCount(0);
  await expect(laptop.page.getByLabel("Poznámky k úkolu")).toHaveValue("Starší z telefonu");
  await expectOnServer(laptop.page, (entity) => entity.id === id && entity.properties?.notes === "Starší z telefonu" && (entity.properties?.syncConflicts as unknown[] | undefined)?.length === 0, true);
  await laptop.context.close();
  await phone.context.close();
});
