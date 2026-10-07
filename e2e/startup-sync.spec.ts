import { expect, test } from "@playwright/test";
import { sessionFile } from "../playwright.config";
import { seeded, serverEntities } from "./helpers";

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
