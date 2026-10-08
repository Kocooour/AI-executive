import { expect, test } from "@playwright/test";
import { sessionFile } from "../playwright.config";
import { seeded, serverEntities, signIn, waitUntilSynced } from "./helpers";

// A change made while the app is still starting must never replace what the server holds.
// Each round opens a browser that has the session but no local copy yet, and adds a task as
// early as the page allows; the seeded data on the server has to survive every round.
test("adding a task while the app is still loading keeps everything on the server", async ({ browser }) => {
  test.setTimeout(120_000);
  const titles: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
    const page = await context.newPage();
    const title = `Hned po startu ${round}-${Date.now()}`;
    titles.push(title);
    await page.goto("/?view=Inbox", { waitUntil: "commit" });
    const field = page.locator(".capture input");
    const added = page.locator("strong", { hasText: title });
    // The row can be on screen before it reacts to typing; try until the task is really added.
    await expect(async () => {
      if (await added.count() === 0) {
        await field.fill(title);
        await field.press("Enter");
      }
      await expect(added).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-executive-pending-sync")), { timeout: 20_000 }).toBeNull();
    const entities = await serverEntities(page);
    const present = (name: string) => entities.some((entity) => entity.title === name);
    // (The seeded project is deleted by an earlier scenario, so it is not part of this check.)
    expect({ round, overdue: present(seeded.overdueTask), plain: present(seeded.plainTask), added: titles.filter(present).length })
      .toEqual({ round, overdue: true, plain: true, added: titles.length });
    await context.close();
  }
});

// The same race on a device that already has a local copy, while another device has changed
// the server in the meantime: the other device's record must survive an early local change.
test("an early change on a device with an older copy keeps what another device saved", async ({ browser }) => {
  test.setTimeout(120_000);
  for (let round = 0; round < 4; round += 1) {
    const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
    const page = await context.newPage();
    await page.goto("/?view=Inbox");
    await expect.poll(() => page.evaluate(() => [localStorage.getItem("ai-executive-server-synced"), localStorage.getItem("ai-executive-pending-sync")]), { timeout: 20_000 }).toEqual(["1", null]);
    // "Another device": the server copy changes without this browser's local copy knowing.
    const foreign = `Z jiného zařízení ${round}-${Date.now()}`;
    const status = await page.evaluate(async (title) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const now = Date.now();
      const entity = { id: `foreign-${now}`, type: "task", title, status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: now, updatedAt: now };
      const saved = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: snapshot.revision, entities: [...snapshot.entities, entity], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
      return saved.status;
    }, foreign);
    expect(status).toBe(200);
    const title = `Na starší kopii ${round}-${Date.now()}`;
    await page.reload({ waitUntil: "commit" });
    const field = page.locator(".capture input");
    const added = page.locator("strong", { hasText: title });
    await expect(async () => {
      if (await added.count() === 0) {
        await field.fill(title);
        await field.press("Enter");
      }
      await expect(added).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-executive-pending-sync")), { timeout: 20_000 }).toBeNull();
    const entities = await serverEntities(page);
    expect({ round, foreign: entities.some((entity) => entity.title === foreign), added: entities.some((entity) => entity.title === title), seeded: entities.some((entity) => entity.title === seeded.overdueTask) })
      .toEqual({ round, foreign: true, added: true, seeded: true });
    await expect(page.locator("strong", { hasText: foreign })).toBeVisible();
    await context.close();
  }
});

// A save that had to be merged with the server and was overtaken by another local change:
// the device must not treat the merged state as its own, or its next save would replace it.
test("a change made while a merged save is in flight keeps what another device saved", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await expect.poll(() => page.evaluate(() => [localStorage.getItem("ai-executive-server-synced"), localStorage.getItem("ai-executive-pending-sync")]), { timeout: 20_000 }).toEqual(["1", null]);
  const stamp = Date.now();
  const foreign = `Cizí záznam ${stamp}`;
  expect(await page.evaluate(async (title) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const entity = { id: `foreign-merge-${now}`, type: "task", title, status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: now, updatedAt: now };
    const saved = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, entities: [...snapshot.entities, entity], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    return saved.status;
  }, foreign)).toBe(200);

  // Hold the answer to the first successful save that follows a conflict.
  let sawConflict = false;
  let held = false;
  let release = () => {};
  const holding = new Promise<void>((resolve) => { release = resolve; });
  let holdStarted = () => {};
  const holdActive = new Promise<void>((resolve) => { holdStarted = resolve; });
  await page.route("**/api/store", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    if (response.status() === 409) sawConflict = true;
    else if (response.status() === 200 && sawConflict && !held) {
      held = true;
      holdStarted();
      await holding;
    }
    await route.fulfill({ response });
  });

  const field = page.locator(".capture input");
  const first = `První ${stamp}`;
  const second = `Druhý ${stamp}`;
  await field.fill(first);
  await field.press("Enter");
  await holdActive;
  await field.fill(second);
  await field.press("Enter");
  // The list is redrawn only after the save, so look for the second task in the local database.
  await expect.poll(() => page.evaluate((title) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const all = request.result.transaction("entities").objectStore("entities").getAll();
      all.onsuccess = () => { resolve(all.result.some((entity: { title: string }) => entity.title === title)); request.result.close(); };
    };
  }), second), { timeout: 10_000 }).toBe(true);
  release();

  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-executive-pending-sync")), { timeout: 20_000 }).toBeNull();
  const titles = (await serverEntities(page)).map((entity) => entity.title);
  expect({ foreign: titles.includes(foreign), first: titles.includes(first), second: titles.includes(second), seeded: titles.includes(seeded.overdueTask) })
    .toEqual({ foreign: true, first: true, second: true, seeded: true });
  await expect(page.locator("strong", { hasText: foreign })).toBeVisible();
  await context.close();
});

// A browser that signs in for the first time takes the server copy as it is. That copy is then
// in sync: reloading must not send it back as if it held changes of its own.
test("after a first sign-in on a new browser, reloading sends nothing", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await signIn(page);
  await expect(page.getByText(seeded.plainTask)).toBeVisible();
  const revision = () => page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json()).then((snapshot) => snapshot.revision as number));
  await waitUntilSynced(page);
  const before = await revision();
  expect(await page.evaluate(() => localStorage.getItem("ai-executive-server-synced"))).toBe("1");
  await page.reload();
  await expect(page.getByText(seeded.plainTask)).toBeVisible();
  await waitUntilSynced(page);
  expect(await revision()).toBe(before);
  await context.close();
});

// Typing into the Inbox row before the server copy has arrived adds the task on the first try,
// without an error, and it reaches the server once.
test("a task typed into Inbox before the server copy arrives is added on the first try", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  let held = false;
  await page.route("**/api/store", async (route) => {
    if (!held && route.request().method() === "GET") {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    await route.continue();
  });
  const title = `Před načtením ${Date.now()}`;
  await page.goto("/?view=Inbox");
  const field = page.locator(".capture input");
  await field.fill(title);
  await field.press("Enter");
  await expect(page.locator("strong", { hasText: title })).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(page.locator(".captureRowError")).toHaveCount(0);
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.title === title).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await serverEntities(page)).some((entity) => entity.title === seeded.plainTask)).toBe(true);
  await context.close();
});

// A workspace that is not on this device yet cannot take a new item: the row says so and keeps
// the text, and the message goes away when the text changes.
test("an item the add row cannot save keeps its text and says so", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  await context.addInitScript(() => {
    localStorage.setItem("ai-executive-active-workspace", "all");
    localStorage.setItem("ai-executive-write-workspace", "not-on-this-device");
  });
  const page = await context.newPage();
  // The server copy is held back, so the chosen workspace is not on this device yet.
  await page.route("**/api/store", async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.continue();
  });
  await page.goto("/?view=Inbox");
  const field = page.locator(".capture input");
  await field.fill("Nelze uložit");
  await field.press("Enter");
  const error = page.locator(".captureRowError");
  await expect(error).toHaveText("Položku se nepodařilo přidat. Zkuste to znovu.");
  await expect(field).toHaveValue("Nelze uložit");
  await field.fill("Nelze uložit!");
  await expect(error).toHaveCount(0);
  await context.close();
});
