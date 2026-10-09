import { expect, test } from "./fixtures";
import { sessionFile } from "../playwright.config";
import { expectOnServer, serverEntities, waitUntilSynced } from "./helpers";

// Opened without a connection to the server, the app could not check access. When the connection
// is back it continues on its own.
test("the app continues by itself when the connection comes back after a start without it", async ({ page }) => {
  await page.route("**/api/auth/status", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".authCard")).toContainText("Nelze ověřit přístup");
  await page.unroute("**/api/auth/status");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".appShell")).toBeVisible({ timeout: 20_000 });
});

// A new task shows at once, marked as waiting, while its save is still on the way.
test("a new task is shown at once and marked until the server has it", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/store", async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  });
  const title = `Hned vidět ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  const row = page.locator("article", { hasText: title });
  await expect(row).toBeVisible({ timeout: 2_000 });
  await expect(row.locator(".unsentMark")).toHaveAttribute("aria-label", "Čeká na uložení");
  release();
  await expectOnServer(page, (entity) => entity.title === title, true);
  await expect(row.locator(".unsentMark")).toHaveCount(0);
});

// A task without a title (left by an older version) would make the server refuse every save.
// It stays on this device, everything else is sent, and it can be fixed.
test("a task the server would refuse is held back, the rest is sent, and it can be fixed", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const id = `e2e-untitled-${Date.now()}`;
  await page.evaluate((taskId) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const now = Date.now();
      const put = request.result.transaction("entities", "readwrite").objectStore("entities").put({
        id: taskId, type: "task", title: "", status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: now, updatedAt: now,
      });
      put.onsuccess = () => { request.result.close(); resolve(); };
      put.onerror = () => reject(put.error);
    };
  }), id);
  const other = `Uloží se i tak ${Date.now()}`;
  await page.locator(".capture input").fill(other);
  await page.locator(".capture input").press("Enter");
  await expectOnServer(page, (entity) => entity.title === other, true);
  expect((await serverEntities(page)).some((entity) => entity.id === id)).toBe(false);
  const notice = page.locator(".heldBack");
  await expect(notice).toContainText("Položky, které nejde uložit");
  await expect(notice).toContainText("nemá název");
  await notice.getByRole("button", { name: "Opravit" }).click();
  await expect(page.locator(".recordHeldBack")).toContainText("nemá název");
  await page.locator("input.titleEdit").fill("Opravený název");
  await page.getByLabel("Poznámky k úkolu").focus();
  await expectOnServer(page, (entity) => entity.id === id && entity.title === "Opravený název", true);
  await expect(notice).toHaveCount(0);
  await context.close();
});
