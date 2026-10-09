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
