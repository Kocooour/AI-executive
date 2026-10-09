import { expect, test } from "./fixtures";
import { sessionFile } from "../playwright.config";
import { expectOnServer, serverEntities, settingsSections, signIn, waitUntilSynced } from "./helpers";

// Two tabs of the same browser share the local database (lib/tab-coordination.ts).

test("a task added in one tab appears in the other open tab without reloading", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const first = await context.newPage(), second = await context.newPage();
  await first.goto("/?view=Inbox");
  await waitUntilSynced(first);
  await second.goto("/?view=Inbox");
  await waitUntilSynced(second);
  const title = `Z první karty ${Date.now()}`;
  const field = first.locator(".capture input");
  await field.fill(title);
  await field.press("Enter");
  await expectOnServer(first, (entity) => entity.title === title, true);
  await expect(second.locator("strong", { hasText: title })).toBeVisible({ timeout: 10_000 });
  await context.close();
});

// A title typed in another tab is not lost when one tab signs out: it is saved and sent first,
// and nothing of it stays in the browser afterwards.
test("signing out in one tab first saves a title being typed in another", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const writer = await context.newPage(), leaver = await context.newPage();
  await writer.goto("/?view=Inbox");
  await waitUntilSynced(writer);
  const title = `Rozepsáno v jiné kartě ${Date.now()}`;
  const field = writer.locator(".capture input");
  await field.fill(title);
  await field.press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(writer)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await writer.goto(`/?task=${id}`);
  await waitUntilSynced(writer);
  // Typed, but the field is never left.
  await writer.locator("input.titleEdit").fill(`${title} – dopsáno`);
  await leaver.goto("/?view=Settings");
  await waitUntilSynced(leaver);
  await settingsSections(leaver).filter({ hasText: "Přístup" }).click();
  await leaver.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(leaver.locator(".authCard")).toBeVisible({ timeout: 15_000 });
  await expect(writer.locator(".authCard")).toBeVisible({ timeout: 15_000 });
  const local = await leaver.evaluate(() => new Promise<string[]>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const all = request.result.transaction("entities").objectStore("entities").getAll();
      all.onsuccess = () => { resolve(all.result.map((entity: { title: string }) => entity.title)); request.result.close(); };
    };
  }));
  expect(local.filter((name) => name !== "Personal")).toEqual([]);
  await signIn(leaver);
  await expectOnServer(leaver, (entity) => entity.id === id && entity.title === `${title} – dopsáno`, true);
  await context.close();
});

async function openTask(page: import("@playwright/test").Page, id: string) {
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
}

async function newTaskWithChecklist(page: import("@playwright/test").Page, title: string) {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await openTask(page, id);
  const add = page.getByPlaceholder("Přidat položku");
  await add.fill("první");
  await add.press("Enter");
  await expectOnServer(page, (entity) => entity.id === id && Array.isArray(entity.properties?.checklist) && (entity.properties?.checklist as unknown[]).length === 1, true);
  return id;
}

// A tab that cannot reach the server adds a checklist item; the other tab ticks another item of
// the same task. Neither change is lost.
test("checklist changes from two tabs, one of them unable to send, are both kept", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const first = await context.newPage(), second = await context.newPage();
  const id = await newTaskWithChecklist(first, `Checklist ve dvou kartách ${Date.now()}`);
  await openTask(second, id);
  await first.route("**/api/store", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  const add = first.getByPlaceholder("Přidat položku");
  await add.fill("druhá z první karty");
  await add.press("Enter");
  await expect(second.locator(".checklistItem", { hasText: "druhá z první karty" })).toBeVisible({ timeout: 10_000 });
  const firstItem = second.locator(".checklistItem").filter({ has: second.getByText("první", { exact: true }) }).locator("input");
  await firstItem.click();
  await expect(firstItem).toBeChecked();
  await first.unroute("**/api/store");
  await expectOnServer(second, (entity) => {
    const items = (entity.properties?.checklist as Array<{ title: string; done: boolean }> | undefined) || [];
    return entity.id === id && items.length === 2 && items.some((item) => item.title === "první" && item.done) && items.some((item) => item.title === "druhá z první karty");
  }, true);
  await context.close();
});

// A tab fetches the server copy while another tab is about to save: the save is not undone.
test("a server copy fetched by one tab does not undo another tab's save", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const writer = await context.newPage(), reader = await context.newPage();
  await writer.goto("/?view=Inbox");
  await waitUntilSynced(writer);
  await reader.goto("/?view=Inbox");
  await waitUntilSynced(reader);
  // The reader's next fetch of the server copy is slow.
  let held = false;
  await reader.route("**/api/store", async (route) => {
    if (!held && route.request().method() === "GET") {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    await route.continue();
  });
  await reader.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => held).toBe(true);
  const title = `Uloženo během načítání ${Date.now()}`;
  await writer.locator(".capture input").fill(title);
  await writer.locator(".capture input").press("Enter");
  await expectOnServer(writer, (entity) => entity.title === title, true);
  await waitUntilSynced(reader);
  await expect(reader.locator("strong", { hasText: title })).toBeVisible();
  // One more save from the writer must still carry the task.
  const next = `${title} a další`;
  await writer.locator(".capture input").fill(next);
  await writer.locator(".capture input").press("Enter");
  await expectOnServer(writer, (entity) => entity.title === next, true);
  await expectOnServer(writer, (entity) => entity.title === title, true);
  await context.close();
});

// A new task being typed in another tab cannot be saved; signing out asks before dropping it.
test("signing out asks about a new task being typed in another tab", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const writer = await context.newPage(), leaver = await context.newPage();
  await writer.goto("/?view=Inbox");
  await waitUntilSynced(writer);
  await writer.locator("button", { hasText: "＋" }).first().click();
  await writer.route("**/api/task-suggestions", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await writer.locator(".captureModal").locator("input, textarea").first().fill("Nový úkol v jiné kartě");
  await leaver.goto("/?view=Settings");
  await waitUntilSynced(leaver);
  await settingsSections(leaver).filter({ hasText: "Přístup" }).click();
  await leaver.getByRole("button", { name: "Odhlásit se" }).click();
  const question = leaver.locator("dialog.confirmDialog");
  await expect(question).toContainText("Neuložený text v jiné kartě");
  await expect(writer.locator(".tabNotice")).toHaveText("Odhlašuji v jiné kartě…");
  await question.getByRole("button", { name: "Zrušit" }).click();
  await expect(writer.locator(".tabNotice")).toHaveCount(0);
  await expect(writer.locator(".captureModal").locator("input, textarea").first()).toHaveValue("Nový úkol v jiné kartě");
  expect(await writer.evaluate(() => document.body.inert)).toBe(false);
  await expect(leaver.locator(".authCard")).toHaveCount(0);
  await context.close();
});
