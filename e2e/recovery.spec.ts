import { expect, test } from "./fixtures";
import { sessionFile } from "../playwright.config";
import { expectOnServer, serverEntities, waitUntilSynced } from "./helpers";

// Opened without a connection to the server, the app could not check access. This browser has
// synchronized before, so it shows the data it holds, marked as offline (owner decision
// 2026-10-09). When the connection is back it continues on its own.
// A task captured before stays waiting and is sent once, without the window being focused again.
test("the app continues by itself when the connection comes back after a start without it", async ({ page, context }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await context.setOffline(true);
  const title = `Zachyceno bez spojení ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  await expect(page.locator("article", { hasText: title }).locator(".unsentMark")).toBeVisible();
  await context.setOffline(false);
  // The app starts again while the server cannot be reached.
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toContainText("Bez spojení.");
  await expect(page.locator(".authCard")).toHaveCount(0);
  await expect(page.locator("article", { hasText: title })).toBeVisible();
  // Captured while offline, it waits to be sent as well.
  const offlineTitle = `Zachyceno po startu bez spojení ${Date.now()}`;
  await page.locator(".capture input").fill(offlineTitle);
  await page.locator(".capture input").press("Enter");
  await expect(page.locator("article", { hasText: offlineTitle }).locator(".unsentMark")).toBeVisible();
  await page.unroute("**/api/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".offlineStart")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".appShell")).toBeVisible();
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.title === offlineTitle).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.title === title).length, { timeout: 20_000 }).toBe(1);
  await expect(page.locator("article", { hasText: title }).locator(".unsentMark")).toHaveCount(0);
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

// A record held on this device can become valid through another device's change (here the title
// fixed there). This device's other change kept by the merge (the notes) is then sent too, not
// left on this device as if it were saved.
test("a held task fixed on another device still sends this device's other change", async ({ browser }) => {
  const laptop = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const phone = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const laptopPage = await laptop.newPage(), phonePage = await phone.newPage();
  await laptopPage.goto("/?view=Inbox");
  await waitUntilSynced(laptopPage);
  const title = `Opraví jiné zařízení ${Date.now()}`;
  await laptopPage.locator(".capture input").fill(title);
  await laptopPage.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(laptopPage)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await phonePage.goto("/?view=Inbox");
  await waitUntilSynced(phonePage);
  await expect(phonePage.locator("article", { hasText: title })).toBeVisible();
  // On the phone the task gets a title the server refuses and new notes (as an older version
  // could leave them).
  await phonePage.evaluate((taskId) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const store = request.result.transaction("entities", "readwrite").objectStore("entities");
      const get = store.get(taskId);
      get.onsuccess = () => {
        const task = get.result;
        const put = store.put({ ...task, title: "x".repeat(1001), properties: { ...task.properties, notes: "Poznámka z telefonu" }, updatedAt: Date.now() });
        put.onsuccess = () => { request.result.close(); resolve(); };
        put.onerror = () => reject(put.error);
      };
      get.onerror = () => reject(get.error);
    };
  }), id);
  // Later the laptop renames it.
  await laptopPage.waitForTimeout(20);
  await laptopPage.goto(`/?task=${id}`);
  await waitUntilSynced(laptopPage);
  await laptopPage.locator("input.titleEdit").fill("Opraveno na notebooku");
  await laptopPage.getByLabel("Poznámky k úkolu").focus();
  await expectOnServer(laptopPage, (entity) => entity.id === id && entity.title === "Opraveno na notebooku", true);
  // The phone takes the server copy over: its title loses to the newer one, its notes stay and
  // are sent.
  await phonePage.reload();
  await waitUntilSynced(phonePage);
  await expectOnServer(phonePage, (entity) => entity.id === id && entity.title === "Opraveno na notebooku" && entity.properties?.notes === "Poznámka z telefonu", true);
  await expect(phonePage.locator(".heldBack")).toHaveCount(0);
  await laptop.close();
  await phone.close();
});

// A valid record in a workspace the server does not know stays held: taking the server copy over
// does not start one save after another.
test("a task held because of its workspace does not make the app save again and again", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Neznámý prostor ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await waitUntilSynced(page);
  await page.evaluate((taskId) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const store = request.result.transaction("entities", "readwrite").objectStore("entities");
      const get = store.get(taskId);
      get.onsuccess = () => {
        const task = get.result;
        const put = store.put({ ...task, workspaceId: "e2e-ghost-workspace", properties: { ...task.properties, notes: "Jen tady" }, updatedAt: Date.now() });
        put.onsuccess = () => { request.result.close(); resolve(); };
        put.onerror = () => reject(put.error);
      };
      get.onerror = () => reject(get.error);
    };
  }), id);
  let saves = 0;
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/store")) saves += 1; });
  await page.reload();
  await waitUntilSynced(page);
  await page.waitForTimeout(4_000);
  expect(saves).toBeLessThanOrEqual(3);
  const onServer = (await serverEntities(page)).find((entity) => entity.id === id);
  expect((onServer as { workspaceId?: string } | undefined)?.workspaceId).toBe("personal");
});

// A task created here in a workspace the server did not know is held back. Once another device
// has created that workspace, the task is sent without anything else being changed here.
test("a task held for its unknown workspace is sent once the workspace exists", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const stamp = Date.now();
  const workspaceId = `e2e-later-${stamp}`;
  const id = `e2e-held-ws-${stamp}`;
  await page.evaluate(({ taskId, workspace }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const now = Date.now();
      const put = request.result.transaction("entities", "readwrite").objectStore("entities").put({
        id: taskId, type: "task", title: "Čeká na prostor", status: "open", workspaceId: workspace, properties: { inbox: true }, createdAt: now, updatedAt: now,
      });
      put.onsuccess = () => { request.result.close(); resolve(); };
      put.onerror = () => reject(put.error);
    };
  }), { taskId: id, workspace: workspaceId });
  await page.reload();
  await waitUntilSynced(page);
  expect((await serverEntities(page)).some((entity) => entity.id === id)).toBe(false);
  // Another device creates the workspace.
  await page.evaluate(async (workspace) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const created = { id: `workspace:${workspace}`, type: "workspace", title: "Později", status: "active", workspaceId: workspace,
      properties: { kind: "shared", role: "owner", members: [] }, createdAt: now, updatedAt: now };
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, entities: [...snapshot.entities, created], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    if (!response.ok) throw new Error(`workspace not created: ${response.status}`);
  }, workspaceId);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectOnServer(page, (entity) => entity.id === id, true);
});

// A workspace the server knows, with a name it would refuse (left by an older version): it is
// not offered for deletion (that would drop its records), and its records are not shown as held
// because they are still sent.
test("a held workspace is not offered for deletion and its records are not shown as held", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const workspaceTitle = "W".repeat(130);
  await page.evaluate((title) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const store = request.result.transaction("entities", "readwrite").objectStore("entities");
      const get = store.get("workspace:personal");
      get.onsuccess = () => {
        const put = store.put({ ...get.result, title, updatedAt: Date.now() });
        put.onsuccess = () => { request.result.close(); resolve(); };
        put.onerror = () => reject(put.error);
      };
    };
  }), workspaceTitle);
  await page.reload();
  await waitUntilSynced(page);
  const notice = page.locator(".heldBack");
  await expect(notice.locator(".heldBackItem")).toHaveCount(1);
  await expect(notice).toContainText("Zkraťte název workspace v Nastavení → Workspace.");
  await expect(notice.getByRole("button", { name: "Smazat" })).toHaveCount(0);
  // Put back so that the following scenarios start with a valid workspace.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const store = request.result.transaction("entities", "readwrite").objectStore("entities");
      const get = store.get("workspace:personal");
      get.onsuccess = () => { store.put({ ...get.result, title: "Osobní", updatedAt: Date.now() }).onsuccess = () => { request.result.close(); resolve(); }; };
    };
  }));
});

// A browser that has never synchronized (or was signed out) has nothing to show: without a
// connection it stays on the access screen.
test("without data of an earlier sign-in, a start without connection shows only the access screen", async ({ browser }) => {
  const context = await browser.newContext({ locale: "cs-CZ" });
  const page = await context.newPage();
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".authCard")).toContainText("Nelze ověřit přístup");
  await expect(page.locator(".offlineStart")).toHaveCount(0);
  await context.close();
});

// The session has ended on the server meanwhile: when the connection comes back the sign-in screen
// replaces the offline view.
test("an offline start whose session has ended returns to the sign-in screen when the connection is back", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  await context.clearCookies();
  await page.unroute("**/api/**");
  await page.locator(".offlineStart button").click();
  await expect(page.locator(".authCard")).toContainText("Přihlásit");
  await context.close();
});
