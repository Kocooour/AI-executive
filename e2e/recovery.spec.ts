import { expect, test } from "./fixtures";
import { sessionFile } from "../playwright.config";
import { confirmDialog, expectOnServer, serverEntities, settingsSections, sidebarView, waitUntilSynced } from "./helpers";

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
  await expect(page.locator("article", { hasText: title }).locator('.taskRowMeta[data-meta-kind="sync"]')).toBeVisible();
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
  await expect(page.locator("article", { hasText: offlineTitle }).locator('.taskRowMeta[data-meta-kind="sync"]')).toBeVisible();
  await page.unroute("**/api/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".offlineStart")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".appShell")).toBeVisible();
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.title === offlineTitle).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.title === title).length, { timeout: 20_000 }).toBe(1);
  await expect(page.locator("article", { hasText: title }).locator('.taskRowMeta[data-meta-kind="sync"]')).toHaveCount(0);
  await expect(page.locator("article", { hasText: offlineTitle }).locator('.taskRowMeta[data-meta-kind="sync"]')).toHaveCount(0);
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
  await expect(row.locator('.taskRowMeta[data-meta-kind="sync"]')).toContainText("čeká na odeslání");
  release();
  await expectOnServer(page, (entity) => entity.title === title, true);
  await expect(row.locator('.taskRowMeta[data-meta-kind="sync"]')).toHaveCount(0);
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
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: [...snapshot.entities, created], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
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
  // Said the same way as an expiry noticed while online.
  await expect(page.locator(".authCard .authNotice")).toContainText("Přihlášení vypršelo");
  await context.close();
});

// Started offline, signing out is offered and refused with an explanation; nothing is removed.
test("signing out after an offline start is refused and removes nothing", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/?view=Settings");
  await expect(page.locator(".offlineStart")).toBeVisible();
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator("p.formError")).toContainText("Server není dostupný");
  await expect(page.locator(".offlineStart")).toBeVisible();
  expect(await page.evaluate(() => indexedDB.databases().then((list) => list.some((database) => database.name === "ai-executive")))).toBe(true);
  // "Try again" still without a connection says so.
  await page.locator(".offlineStart button").click();
  await expect(page.locator(".offlineStart")).toContainText("Stále bez spojení.");
  await context.close();
});

// Signed in before but holding no records (everything deleted): an offline start still shows the
// app, so a new task can be captured; the retry button is a full touch target on a phone.
test("an offline start works without any records and has a full-size retry button on a phone", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ", viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/");
  await waitUntilSynced(page);
  // Only this browser's copy is emptied (the server keeps its data).
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const store = request.result.transaction("entities", "readwrite").objectStore("entities");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const entity of all.result as Array<{ id: string; type: string }>) if (entity.type !== "workspace") store.delete(entity.id);
        store.transaction.oncomplete = () => { request.result.close(); resolve(); };
      };
      all.onerror = () => reject(all.error);
    };
  }));
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  const banner = page.locator(".offlineStart");
  await expect(banner).toBeVisible();
  const box = await banner.locator("button").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await context.close();
});

// Started offline, a question is asked in the app dialog instead of being answered "no" unseen.
test("after an offline start, deleting a project asks in the app dialog", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const project = `Projekt pro offline dotaz ${Date.now()}`;
  await page.getByRole("textbox", { name: "+ Přidat projekt" }).fill(project);
  await page.getByRole("textbox", { name: "+ Přidat projekt" }).press("Enter");
  await expectOnServer(page, (entity) => entity.title === project, true);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  await page.getByText(project).first().click();
  await page.locator(".projectActions button.danger").click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).getByRole("button", { name: "Zrušit" }).click();
  await expect(confirmDialog(page)).not.toBeVisible();
  // The project page shows the name in an input: the page is still open with its name.
  await expect(page.getByRole("textbox", { name: "Název projektu" })).toHaveValue(project);
  await context.close();
});

// Started offline, Quick Capture does not wait for a suggestion the server cannot give: the add
// button is usable at once even when requests stall instead of failing.
test("after an offline start, quick capture adds a task without waiting for a suggestion", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  // A suggestion request would hang (a stalled connection) rather than fail at once.
  await page.route("**/api/task-suggestions", () => undefined);
  const title = `Offline zachyceno bez čekání ${Date.now()}`;
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  await modal.locator("input, textarea").first().fill(title);
  await page.waitForTimeout(1_000);
  await expect(modal.getByRole("button", { name: "Přidat úkol" })).toBeEnabled({ timeout: 1_000 });
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator("article", { hasText: title })).toBeVisible();
  await context.close();
});

// A connection that swallows requests instead of refusing them: nothing in the offline view may
// wait for it forever. The data kept here is shown, the address follows the view, the assistant
// says it needs a connection and signing out is refused with the usual explanation.
test("an offline start over a stalled connection shows the data and never waits forever", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Uloženo před zaseknutým spojením ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  await expectOnServer(page, (entity) => entity.title === title, true);
  await page.route("**/api/**", () => undefined);
  await page.reload();
  // The access check gives up after 8 s; the stalled request for the server copy is given up then.
  await expect(page.locator(".offlineStart")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("article", { hasText: title })).toBeVisible({ timeout: 5_000 });
  await sidebarView(page, "Dnes").click();
  await expect(page).toHaveURL(/view=Today/);
  await page.locator("button", { hasText: "Zeptat se AI" }).first().click();
  await page.locator(".assistantComposer input").fill("Co mám dnes dělat?");
  await page.locator(".assistantComposer input").press("Enter");
  await expect(page.locator(".msg.assistant").last()).toContainText("potřebuje spojení", { timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.locator("button", { hasText: "Nastavení" }).first().click();
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator("p.formError")).toContainText("Server není dostupný", { timeout: 20_000 });
  await context.close();
});

// Starting work on a task is no longer offered (the owner only completes, defers or deletes a task),
// so an offline task opens with its one-button actions and without a start button.
test("an offline task offers complete, defer and delete and no start button", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Práce bez spojení ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  await expectOnServer(page, (entity) => entity.title === title, true);
  await page.route("**/api/**", () => undefined);
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible({ timeout: 20_000 });
  await page.locator("article", { hasText: title }).first().click();
  const detail = page.locator("aside.detail");
  await expect(detail.getByRole("button", { name: "Dokončit" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Smazat" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Spustit" })).toHaveCount(0);
  await context.close();
});

// Started offline, a title is being edited when the server comes back and says the session has
// ended: the edit is kept in this browser (sent after signing in), not lost with the app screen.
test("an offline start whose session has ended keeps a title being edited", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const original = `Před úpravou offline ${Date.now()}`;
  await page.locator(".capture input").fill(original);
  await page.locator(".capture input").press("Enter");
  await expectOnServer(page, (entity) => entity.title === original, true);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  await page.locator("article", { hasText: original }).first().click();
  const field = page.locator("input.titleEdit");
  await expect(field).toHaveValue(original);
  const edited = `${original} upraveno`;
  await field.fill(edited);
  // The field still has focus when the server answers that the session has ended.
  await context.clearCookies();
  await page.unroute("**/api/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".authCard")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate((title) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const all = request.result.transaction("entities").objectStore("entities").getAll();
      all.onsuccess = () => { resolve((all.result as Array<{ title: string }>).some((entity) => entity.title === title)); request.result.close(); };
      all.onerror = () => resolve(false);
    };
    request.onerror = () => resolve(false);
  }), edited)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("ai-executive-pending-sync"))).toBe("1");
  await context.close();
});

// Signed in, but the first synchronization did not complete: this browser does not hold the
// account's data yet, so a later start without a connection stays on the access screen.
test("a browser whose first synchronization did not complete stays on the access screen offline", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.route("**/api/store**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".appShell")).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => localStorage.getItem("ai-executive-signed-in"))).toBeNull();
  await page.unroute("**/api/store**");
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".authCard")).toContainText("Nelze ověřit přístup");
  await expect(page.locator(".offlineStart")).toHaveCount(0);
  await context.close();
});

// A browser that was never signed in, started without a connection: when the server answers, it
// is asked to sign in without being told that a session ended.
test("a browser never signed in is not told its sign-in expired when the connection comes back", async ({ browser }) => {
  // No session and no local data (the project's default session is not used here).
  const context = await browser.newContext({ locale: "cs-CZ", storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".authCard")).toContainText("Nelze ověřit přístup");
  await page.unroute("**/api/**");
  // The background check that runs when the connection comes back.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator('.authCard input[type="password"]')).toBeVisible();
  await expect(page.locator(".authCard .authNotice")).toHaveCount(0);
  await context.close();
});

// Started offline, a title is being edited when the server comes back misconfigured (sign-in
// enabled but not set up): the edit is kept in this browser, not lost with the app screen.
test("an offline start that finds the server misconfigured keeps a title being edited", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const original = `Před nastavením serveru ${Date.now()}`;
  await page.locator(".capture input").fill(original);
  await page.locator(".capture input").press("Enter");
  await expectOnServer(page, (entity) => entity.title === original, true);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  await page.locator("article", { hasText: original }).first().click();
  const field = page.locator("input.titleEdit");
  await expect(field).toHaveValue(original);
  const edited = `${original} upraveno`;
  await field.fill(edited);
  await page.unroute("**/api/**");
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { enabled: true, configured: false, authenticated: false } }));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".authCard")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate((title) => new Promise<boolean>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const all = request.result.transaction("entities").objectStore("entities").getAll();
      all.onsuccess = () => { resolve((all.result as Array<{ title: string }>).some((entity) => entity.title === title)); request.result.close(); };
      all.onerror = () => resolve(false);
    };
    request.onerror = () => resolve(false);
  }), edited)).toBe(true);
  await context.close();
});

// The connection is back but the background check has not run yet: signing out checks access
// first, so a change made offline is sent instead of being offered for discarding.
test("signing out after an offline start sends offline changes once the connection is back", async ({ browser }) => {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  const title = `Před odhlášením offline ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  await expect(page.locator("article", { hasText: title }).locator('.taskRowMeta[data-meta-kind="sync"]')).toContainText("čeká na odeslání");
  await page.unroute("**/api/**");
  await page.locator("button", { hasText: "Nastavení" }).first().click();
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator(".authCard")).toBeVisible({ timeout: 20_000 });
  await expect(confirmDialog(page)).not.toBeVisible();
  // Signed out here; another device with a session sees the change on the server.
  const other = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  await expect.poll(async () => (await serverEntities(otherPage)).some((entity) => entity.title === title)).toBe(true);
  // A synchronization finishing late (another tab) cannot make this browser eligible again.
  await page.evaluate(() => localStorage.setItem("ai-executive-signed-in", "1"));
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".authCard")).toContainText("Nelze ověřit přístup");
  await expect(page.locator(".offlineStart")).toHaveCount(0);
  await other.close();
  await context.close();
});

// The first request for the server copy answers, but the next one (the refresh started by it)
// stalls together with the access check: the offline view shows this browser's data at once
// instead of after that request gives up.
test("an offline start waiting on a later stalled request shows this browser's data at once", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const page = await context.newPage();
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Uloženo před pomalým startem ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  await expectOnServer(page, (entity) => entity.title === title, true);
  let storeRequests = 0;
  await page.route("**/api/store**", async (route) => {
    storeRequests += 1;
    if (storeRequests === 1) await route.continue();
  });
  await page.route("**/api/auth/status", () => undefined);
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("article", { hasText: title })).toBeVisible({ timeout: 3_000 });
  await context.close();
});
