import { expect, test } from "./fixtures";
import { confirmDialog, expectOnServer, heading, seeded, serverEntities, settingsSections, sidebarView, signIn, waitUntilSynced } from "./helpers";

// The scenarios share one instance and run in this order, one at a time (see the config).
// A failing scenario does not stop the ones after it. Signing out comes last.

// The app must never fall back to a system dialog; if one appears it is dismissed and the scenario fails.
const systemDialogs: string[] = [];
test.beforeEach(async ({ page }) => {
  systemDialogs.length = 0;
  page.on("dialog", (dialog) => { systemDialogs.push(dialog.message()); void dialog.dismiss(); });
});
test.afterEach(() => {
  expect(systemDialogs).toEqual([]);
});

test("Home shows the brief with seeded attention", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".appShell")).toBeVisible();
  const attention = page.locator(".attentionSection");
  await expect(attention.locator(".attentionItem", { hasText: seeded.overdueTask })).toBeVisible();
  await expect(attention.locator(".attentionStale")).toHaveCount(0);
});

test("a captured task appears in Inbox and reaches the server", async ({ page }) => {
  const title = `Zachycený úkol ${Date.now()}`;
  await page.goto("/");
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  await modal.locator("input, textarea").first().fill(title);
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await sidebarView(page, "Doručené").click();
  await expect(page.getByText(title)).toBeVisible();
  await expectOnServer(page, (entity) => entity.title === title, true);
});

test("a task keeps its selected area and can change it after capture", async ({ page }) => {
  const title = `Úkol v oblasti ${Date.now()}`;
  await page.goto("/");
  // Seeding replaces the store; it must not race the first synchronization of the page.
  await waitUntilSynced(page);
  const ids = await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const first = `e2e-area-family-${now}`;
    const second = `e2e-area-home-${now}`;
    const area = (id: string, name: string) => ({ id, type: "area", title: name, status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, entities: [...snapshot.entities, area(first, "Rodina"), area(second, "Dům")], relations: snapshot.relations, deletedIds: [], revivedIds: [],
    }) });
    if (!response.ok) throw new Error(`Could not seed areas: ${response.status}`);
    return { first, second };
  });
  await page.reload();
  await waitUntilSynced(page);
  await page.route("**/api/task-suggestions", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  await modal.getByLabel("Název úkolu").fill(title);
  await expect(modal.locator(".captureSuggestionState.error")).toBeVisible();
  await modal.getByLabel("Oblast").selectOption(ids.first);
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async (name) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const task = snapshot.entities.find((entity: { title: string }) => entity.title === name);
    return snapshot.relations.find((relation: { sourceEntityId: string; relationType: string }) => relation.sourceEntityId === task?.id && relation.relationType === "belongs_to_area")?.targetEntityId;
  }, title)).toBe(ids.first);
  await page.goto("/?view=Inbox");
  const row = page.locator("article", { hasText: title }).first();
  await expect(row).toContainText("Rodina");
  await row.click();
  await page.locator("aside.detail").getByLabel("Oblast").selectOption(ids.second);
  const duration = page.locator("aside.detail").getByLabel("Odhadovaná náročnost");
  await duration.fill("4");
  await expectOnServer(page, (entity) => entity.title === title && entity.properties?.estimatedMinutes === 4, true);
  await expect.poll(async () => page.evaluate(async (name) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const task = snapshot.entities.find((entity: { title: string }) => entity.title === name);
    return snapshot.relations.find((relation: { sourceEntityId: string; relationType: string }) => relation.sourceEntityId === task?.id && relation.relationType === "belongs_to_area")?.targetEntityId;
  }, title)).toBe(ids.second);
  await page.reload();
  await expect(page.locator("article", { hasText: title }).first()).toContainText("Dům");
  await page.locator("article", { hasText: title }).first().click();
  await expect(page.locator("aside.detail").getByLabel("Odhadovaná náročnost")).toHaveValue("4");
});

test("capture switches destination and area to the selected workspace", async ({ page }) => {
  const title = `Úkol pro jiný prostor ${Date.now()}`;
  await page.goto("/");
  // Seeding replaces the store; it must not race the first synchronization of the page.
  await waitUntilSynced(page);
  const ids = await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const workspaceId = `e2e-family-workspace-${now}`;
    const personalAreaId = `e2e-personal-area-${now}`;
    const targetAreaId = `e2e-family-area-${now}`;
    const area = (id: string, workspaceId: string) => ({ id, type: "area", title: "Rodina", status: "active", workspaceId, properties: {}, createdAt: now, updatedAt: now });
    const workspace = { id: `workspace:${workspaceId}`, type: "workspace", title: "Rodina sdílená", status: "active", workspaceId,
      properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now };
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, entities: [...snapshot.entities, workspace, area(personalAreaId, "personal"), area(targetAreaId, workspaceId)],
      relations: snapshot.relations, deletedIds: [], revivedIds: [],
    }) });
    if (!response.ok) throw new Error(`Could not seed shared workspace: ${response.status}`);
    return { workspaceId, personalAreaId, targetAreaId };
  });
  await page.reload();
  await waitUntilSynced(page);
  await expect(page.locator(".workspaceButton")).toContainText("Osobní");
  let suggestedFor = "";
  await page.route("**/api/task-suggestions", (route) => {
    suggestedFor = JSON.parse(route.request().postData() || "{}").workspaceId;
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
  });
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  const area = modal.getByLabel("Oblast");
  await area.selectOption(ids.personalAreaId);
  await modal.getByLabel("Workspace").selectOption(ids.workspaceId);
  await expect(area).toHaveValue("");
  await expect(area.locator(`option[value="${ids.personalAreaId}"]`)).toHaveCount(0);
  await expect(area.locator(`option[value="${ids.targetAreaId}"]`)).toHaveCount(1);
  await modal.getByLabel("Název úkolu").fill(title);
  await expect.poll(() => suggestedFor).toBe(ids.workspaceId);
  await area.selectOption(ids.targetAreaId);
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async (name) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const task = snapshot.entities.find((entity: { title: string }) => entity.title === name);
    return { workspaceId: task?.workspaceId, areaId: snapshot.relations.find((relation: { sourceEntityId: string; relationType: string }) =>
      relation.sourceEntityId === task?.id && relation.relationType === "belongs_to_area")?.targetEntityId };
  }, title)).toEqual({ workspaceId: ids.workspaceId, areaId: ids.targetAreaId });
  await expect(page.locator(".workspaceButton")).toContainText("Rodina sdílená");
  await expect(page.locator("article", { hasText: title }).first()).toContainText("Rodina");
});

test("a task added from a project in another workspace offers that workspace's areas", async ({ page }) => {
  const title = `Úkol do projektu jiného prostoru ${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  const ids = await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const workspaceId = `e2e-project-workspace-${now}`;
    const entity = (id: string, type: string, title: string, workspace: string, extra: Record<string, unknown> = {}) =>
      ({ id, type, title, status: "active", workspaceId: workspace, properties: {}, createdAt: now, updatedAt: now, ...extra });
    const ids = { workspaceId, projectId: `e2e-other-project-${now}`, otherAreaId: `e2e-other-area-${now}`, personalAreaId: `e2e-own-area-${now}` };
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision,
      entities: [...snapshot.entities,
        entity(`workspace:${workspaceId}`, "workspace", "Druhý prostor", workspaceId, { properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] } }),
        entity(ids.projectId, "project", "Projekt v druhém prostoru", workspaceId),
        entity(ids.otherAreaId, "area", "Oblast druhého prostoru", workspaceId),
        entity(ids.personalAreaId, "area", "Vlastní oblast", "personal")],
      relations: snapshot.relations, deletedIds: [], revivedIds: [],
    }) });
    if (!response.ok) throw new Error(`Could not seed: ${response.status}`);
    return ids;
  });
  // "All my work" is open and new tasks go to the personal workspace by default.
  await page.evaluate(() => {
    localStorage.setItem("ai-executive-active-workspace", "all");
    localStorage.setItem("ai-executive-write-workspace", "personal");
  });
  // Opened from the project list (a link would switch to the project's workspace).
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await page.locator("article", { hasText: "Projekt v druhém prostoru" }).first().click();
  let suggestedFor = "";
  await page.route("**/api/task-suggestions", (route) => {
    suggestedFor = JSON.parse(route.request().postData() || "{}").workspaceId;
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
  });
  await page.locator("aside.detail").getByRole("button", { name: /Přidat úkol/ }).click();
  const modal = page.locator(".captureModal");
  const area = modal.getByLabel("Oblast");
  await expect(area.locator(`option[value="${ids.otherAreaId}"]`)).toHaveCount(1);
  await expect(area.locator(`option[value="${ids.personalAreaId}"]`)).toHaveCount(0);
  await modal.getByLabel("Název úkolu").fill(title);
  // Suggestions (area, calendar window) are asked for in the project's workspace.
  await expect.poll(() => suggestedFor).toBe(ids.workspaceId);
  await area.selectOption(ids.otherAreaId);
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async (name) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const task = snapshot.entities.find((entity: { title: string }) => entity.title === name);
    return { workspaceId: task?.workspaceId, areaId: snapshot.relations.find((relation: { sourceEntityId: string; relationType: string }) =>
      relation.sourceEntityId === task?.id && relation.relationType === "belongs_to_area")?.targetEntityId };
  }, title)).toEqual({ workspaceId: ids.workspaceId, areaId: ids.otherAreaId });
});

test("a task typed into the row of Someday or Upcoming stays in that view", async ({ page }) => {
  for (const [view, label] of [["Someday", "Někdy"], ["Upcoming", "Nadcházející"]]) {
    const title = `Řádek ${label} ${Date.now()}`;
    await page.goto(`/?view=${view}`);
    await expect(heading(page)).toHaveText(label);
    await waitUntilSynced(page);
    await page.locator(".capture input").fill(title);
    await page.keyboard.press("Enter");
    await expect(page.getByText(title)).toBeVisible();
    await waitUntilSynced(page);
    await page.goto("/?view=Anytime");
    await expect(heading(page)).toHaveText("Kdykoli");
    await expect(page.getByText(title)).toHaveCount(0);
    await page.goto(`/?view=${view}`);
    await expect(page.getByText(title)).toBeVisible();
  }
});

test("the capture dialog opened from Upcoming does not date a task that goes to a project", async ({ page }) => {
  const title = `Do projektu ${Date.now()}`;
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await page.evaluate(async (name) => {
    // A project to choose, added the way another device would add it.
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: [...snapshot.entities, { id: `e2e-capture-project-${now}`, type: "project", title: name, status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now }],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  }, "Projekt pro zachycení");
  await page.reload();
  await waitUntilSynced(page);
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  await modal.locator("input, textarea").first().fill(title);
  await modal.locator("select").filter({ has: page.locator("option", { hasText: "Projekt pro zachycení" }) }).first().selectOption({ label: "Projekt pro zachycení" });
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json())))
    .entities.find((entity: { title: string }) => entity.title === title)?.properties, { timeout: 20_000 })
    .toMatchObject({ inbox: false, today: false });
  const saved = (await page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json()))).entities.find((entity: { title: string }) => entity.title === title);
  expect(saved.properties.when ?? "").toBe("");
  expect(saved.properties.someday ?? false).toBe(false);
});

test("a date typed with spaces at the end of the text becomes the task's date", async ({ page }) => {
  const title = `Zaplatit pojistku ${Date.now()}`;
  const nextYear = new Date().getFullYear() + 1;
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.locator(".capture input").fill(`${title} 24. 12. ${nextYear}`);
  await page.keyboard.press("Enter");
  // Leave the page only once the task is saved; navigating straight away can cut the save off.
  await expectOnServer(page, (entity) => entity.title === title, true);
  await page.goto("/?view=Upcoming");
  await expect(page.getByText(title, { exact: true })).toBeVisible();
});

test("the address follows the view; Back, Forward and reload keep the place", async ({ page }) => {
  await page.goto("/");
  await expect(heading(page)).toBeVisible();
  await sidebarView(page, "Projekty").click();
  await expect(page).toHaveURL(/\?view=Projects$/);
  await sidebarView(page, "Dnes").click();
  await expect(page).toHaveURL(/\?view=Today$/);
  await page.goBack();
  await expect(page).toHaveURL(/\?view=Projects$/);
  await expect(heading(page)).toHaveText("Projekty");
  await page.goForward();
  await expect(heading(page)).toHaveText("Dnes");
  await page.reload();
  await expect(heading(page)).toHaveText("Dnes");
  await page.goto("/?view=Nonsense&workspace=personal");
  await expect(page).toHaveURL(/\/$/);
});

test("a task link opens the task and its id leaves the address", async ({ page }) => {
  await page.goto("/?task=e2e-plain");
  await expect(page.locator(`input[value="${seeded.plainTask}"]`)).toBeVisible();
  await expect(page).not.toHaveURL(/task=/);
});

test("deleting a project asks in the app dialog; Escape cancels, confirming deletes", async ({ page }) => {
  await page.goto("/?view=Projects");
  await page.getByText(seeded.project).first().click();
  const remove = page.locator(".projectActions button.danger");
  const dialog = confirmDialog(page);
  await remove.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  // Cancelled means still there after everything has been sent and the page loaded again.
  await waitUntilSynced(page);
  await page.reload();
  await page.getByText(seeded.project).first().click();
  await expectOnServer(page, (entity) => entity.id === "e2e-project", true);
  await remove.click();
  await expect(dialog).toHaveRole("alertdialog");
  await dialog.getByRole("button", { name: "Smazat" }).click();
  await expect(dialog).toHaveCount(0);
  await expectOnServer(page, (entity) => entity.id === "e2e-project", false);
});

test("fast typing into a task's notes keeps every character and is saved when leaving the field", async ({ page }) => {
  const notes = `Zavolat ve středu, číslo 777 123 456, ${Date.now()}`;
  await page.goto("/?task=e2e-plain");
  const field = page.getByLabel("Poznámky k úkolu");
  await expect(field).toBeVisible();
  await waitUntilSynced(page);
  await field.pressSequentially(notes, { delay: 0 });
  await expect(field).toHaveValue(notes);
  await page.locator("input.titleEdit").focus();
  await expectOnServer(page, (entity) => entity.id === "e2e-plain" && entity.properties?.notes === notes, true);
});

test("closing the task right after editing its notes saves them and keeps the panel closed", async ({ page }) => {
  const notes = `Před zavřením ${Date.now()}`;
  await page.goto("/?task=e2e-plain");
  const field = page.getByLabel("Poznámky k úkolu");
  await waitUntilSynced(page);
  await field.fill(notes);
  await page.locator("aside.detail button.close").click();
  await expect(page.locator("aside.detail")).toHaveCount(0);
  await expectOnServer(page, (entity) => entity.id === "e2e-plain" && entity.properties?.notes === notes, true);
  await page.waitForTimeout(500);
  await expect(page.locator("aside.detail")).toHaveCount(0);
});

test("notes still being typed are saved when the app goes to the background", async ({ page }) => {
  const notes = `Na pozadí ${Date.now()}`;
  await page.goto("/?task=e2e-rename");
  const field = page.getByLabel("Poznámky k úkolu");
  await waitUntilSynced(page);
  await field.fill(notes);
  await expect(field).toBeFocused();
  // What a phone does when the user switches to another app: the page is hidden, the field keeps focus.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === notes, true);
  await expect(field).toHaveValue(notes);
});

test("a title typed while the notes are still being saved is kept", async ({ page }) => {
  const notes = `Při psaní názvu ${Date.now()}`;
  const title = `${seeded.plainTask} (upraveno)`;
  await page.goto("/?task=e2e-plain");
  const field = page.getByLabel("Poznámky k úkolu");
  await waitUntilSynced(page);
  // Slow saves, so that the title is typed while the notes are on their way to the server.
  await page.route("**/api/store", async (route) => {
    if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const titleField = page.locator("input.titleEdit");
  try {
    await field.fill(notes);
    await titleField.click();
    await titleField.fill(title);
    await expectOnServer(page, (entity) => entity.id === "e2e-plain" && entity.properties?.notes === notes, true);
    await page.waitForTimeout(300);
    await expect(titleField).toHaveValue(title);
    await field.focus();
    await expectOnServer(page, (entity) => entity.id === "e2e-plain" && entity.title === title, true);
  } finally {
    // Back to the seeded title for the scenarios that look for it.
    await page.unroute("**/api/store");
    await titleField.fill(seeded.plainTask);
    await field.focus();
    await expectOnServer(page, (entity) => entity.id === "e2e-plain" && entity.title === seeded.plainTask, true);
  }
});

test("a notes draft left by a page that was closed before saving it is saved on the next start", async ({ page }) => {
  const typed = `Rozepsáno ${Date.now()}`;
  await page.goto("/?task=e2e-rename");
  const field = page.getByLabel("Poznámky k úkolu");
  await waitUntilSynced(page);
  await field.fill(typed);
  // Every key press is kept in the device at once.
  expect(Object.values(await page.evaluate(() => JSON.parse(localStorage.getItem("ai-executive-notes-drafts") || "{}"))))
    .toEqual([expect.objectContaining({ id: "e2e-rename", text: typed })]);
  // Leaving the page may cut its own save off; the kept draft is then saved by the next start.
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === typed, true);
  // What a page killed a minute ago leaves behind: a draft started from the current notes, not saved.
  const left = `Po zavření ${Date.now()}`;
  const plant = (draft: { text: string; base: string }) => page.evaluate((value) => localStorage.setItem("ai-executive-notes-drafts",
    JSON.stringify({ "closed-page:e2e-rename": { id: "e2e-rename", ...value, at: Date.now() - 60_000, page: "closed-page" } })), draft);
  await plant({ text: left, base: typed });
  await page.reload();
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === left, true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-executive-notes-drafts"))).toBeNull();
  // A draft started from notes that have changed since (on another device) does not overwrite them.
  await plant({ text: `Zastaralé ${Date.now()}`, base: "jiný základ" });
  await page.reload();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-executive-notes-drafts"))).toBeNull();
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === left, true);
});

test("a leftover notes draft waits until the server's notes are known", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const base = String((await serverEntities(page)).find((entity) => entity.id === "e2e-rename")?.properties?.notes ?? "");
  const left = `Čeká na server ${Date.now()}`;
  await page.evaluate(({ text, base }) => localStorage.setItem("ai-executive-notes-drafts",
    JSON.stringify({ "closed-page:e2e-rename": { id: "e2e-rename", text, base, at: Date.now() - 60_000, page: "closed-page" } })), { text: left, base });
  // The start-up synchronization fails: the draft must not be applied to the possibly old copy.
  await page.route("**/api/store", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".appShell")).toBeVisible();
  await page.waitForTimeout(1500);
  const localNotes = () => page.evaluate(() => new Promise<string>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const get = request.result.transaction("entities").objectStore("entities").get("e2e-rename");
      get.onsuccess = () => { resolve(String(get.result?.properties?.notes ?? "")); request.result.close(); };
    };
  }));
  expect(await localNotes()).toBe(base);
  expect(await page.evaluate(() => localStorage.getItem("ai-executive-notes-drafts"))).not.toBeNull();
  // The connection is back: the next synchronization knows the server's notes, then the draft is saved.
  await page.unroute("**/api/store");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === left, true);
});

test("a draft that another open tab is still typing is left to that tab", async ({ page }) => {
  // Stands in for another tab that keeps the field focused: it answers on the draft channel.
  await page.addInitScript(() => {
    if (localStorage.getItem("e2e-draft-owner") !== "open") return;
    const channel = new BroadcastChannel("ai-executive-notes-draft");
    channel.onmessage = (event) => { if (event.data?.ask === "other-tab") channel.postMessage({ alive: "other-tab" }); };
  });
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const before = String((await serverEntities(page)).find((entity) => entity.id === "e2e-rename")?.properties?.notes ?? "");
  const partial = `Rozepsané v jiné kartě ${Date.now()}`;
  await page.evaluate(({ text, base }) => {
    localStorage.setItem("e2e-draft-owner", "open");
    localStorage.setItem("ai-executive-notes-drafts", JSON.stringify({ "other-tab:e2e-rename": { id: "e2e-rename", text, base, at: Date.now(), page: "other-tab" } }));
  }, { text: partial, base: before });
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.waitForTimeout(1000);
    expect((await serverEntities(page)).find((entity) => entity.id === "e2e-rename")?.properties?.notes ?? "").toBe(before);
  } finally {
    // The other tab is closed without having saved: the next start saves its draft.
    await page.evaluate(() => localStorage.removeItem("e2e-draft-owner"));
  }
  await page.reload();
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === partial, true);
});

test("the personal workspace is shown in Czech and saving its shown name does not rename it", async ({ page }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Workspace" }).first().click();
  const name = page.getByLabel("Název workspace");
  await expect(name).toHaveValue("Osobní");
  await name.press("Enter");
  await expect(page.getByText("Workspace uložen.")).toBeVisible();
  await waitUntilSynced(page);
  expect((await serverEntities(page)).find((entity) => entity.id === "workspace:personal")?.title).toBe("Personal");
});

test("a workspace name being edited survives a language change", async ({ page }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Workspace" }).first().click();
  await page.getByLabel("Název workspace").fill("Moje věci");
  await settingsSections(page).first().click();
  await page.locator("select").filter({ has: page.locator('option[value="en"]') }).selectOption("en");
  await page.locator(".settingsTabs button").filter({ hasText: "Workspace" }).first().click();
  await expect(page.getByRole("textbox", { name: "Workspace name", exact: true })).toHaveValue("Moje věci");
  expect((await serverEntities(page)).find((entity) => entity.id === "workspace:personal")?.title).toBe("Personal");
});

test("Settings shows one section at a time", async ({ page }) => {
  await page.goto("/?view=Settings");
  const tabs = settingsSections(page);
  await expect(tabs).toHaveText(["Obecné", "Workspace", "Přístup", "Oznámení", "Kalendář", "Data a zálohy", "Kontext"]);
  const visibleHeadings = page.locator(".settingsPanel section:not([hidden]) h2");
  await expect(visibleHeadings).toHaveText(["Obecné", "Instalace aplikace"]);
  await tabs.filter({ hasText: "Oznámení" }).click();
  await expect(visibleHeadings).toHaveText(["Připomínky"]);
  await expect(page.locator(".settingsPanel section:not([hidden]) .badgeDiagnostics")).toBeVisible();
});

test("losing the connection keeps the attention list and marks it out of date", async ({ page, context }) => {
  await page.goto("/");
  const attention = page.locator(".attentionSection");
  await expect(attention.locator(".attentionItem").first()).toBeVisible();
  await context.setOffline(true);
  await expect(attention.locator(".attentionStale")).toBeVisible();
  await expect(attention.locator(".attentionItem").first()).toBeVisible();
  await attention.locator(".attentionMore summary").first().click();
  await expect(attention.locator(".attentionActions button").first()).toBeDisabled();
  await context.setOffline(false);
  // Well under the one-minute periodic refresh: coming back online must refresh by itself.
  await expect(attention.locator(".attentionStale")).toHaveCount(0, { timeout: 15_000 });
});

test.describe("on a phone-sized screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the brief and the bottom navigation work without sideways scrolling", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".attentionSection .attentionItem").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(".mobileNav button", { hasText: "Doručené" }).click();
    await expect(heading(page)).toHaveText("Doručené");
    await expect(page).toHaveURL(/\?view=Inbox$/);
    await expect(page.getByText(seeded.plainTask)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test("an expired sign-in asks to sign in again and sends the waiting change afterwards", async ({ page, context }) => {
  const title = `Po vypršení ${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  // The server stops accepting the session (same effect as the session reaching its time limit).
  // The suggestion lookup is answered locally so that the first refused request is the save itself.
  await context.clearCookies();
  await page.route("**/api/task-suggestions", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.locator("button", { hasText: "＋" }).first().click();
  const modal = page.locator(".captureModal");
  await modal.locator("input, textarea").first().fill(title);
  await modal.getByRole("button", { name: "Přidat úkol" }).click();
  const notice = page.locator(".authCard .authNotice");
  await expect(notice).toContainText("Přihlášení vypršelo");
  await expect(notice).toContainText("zůstávají v tomto zařízení");
  await signIn(page);
  await expectOnServer(page, (entity) => entity.title === title, true);
  await sidebarView(page, "Doručené").click();
  await expect(page.getByText(title)).toBeVisible();
});

test("text being typed when the sign-in expires is still there after signing in again", async ({ page, context }) => {
  const title = `Rozepsaný úkol ${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await context.clearCookies();
  await page.locator("button", { hasText: "＋" }).first().click();
  const field = page.locator(".captureModal").locator("input, textarea").first();
  await field.fill(title);
  // Typing asks the server for a suggestion; that request is refused and the sign-in screen appears.
  await expect(page.locator(".authCard .authNotice")).toContainText("Přihlášení vypršelo");
  await signIn(page);
  await expect(page.locator(".authNotice")).toHaveCount(0);
  await expect(field).toHaveValue(title);
  await page.locator(".captureModal").getByRole("button", { name: "Přidat úkol" }).click();
  await expectOnServer(page, (entity) => entity.title === title, true);
});

test("a title being edited when the sign-in expires is saved and sent after signing in again", async ({ page, context }) => {
  const title = `Přejmenováno ${Date.now()}`;
  await page.goto("/?task=e2e-rename");
  const field = page.locator("input.titleEdit");
  await expect(field).toHaveValue(seeded.renameTask);
  await waitUntilSynced(page);
  await context.clearCookies();
  await field.fill(title);
  // The field still has focus; a background request notices the expiry.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".authCard .authNotice")).toBeVisible();
  await signIn(page);
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.title === title, true);
});

test("signing out after the sign-in has expired does not leave a question behind", async ({ page, context }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  // An unsent change exists and the session is gone: the save is refused, then sign-out is pressed.
  await page.evaluate(() => localStorage.setItem("ai-executive-pending-sync", "1"));
  await context.clearCookies();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator(".authCard .authNotice")).toBeVisible();
  await signIn(page);
  await expect(page.locator(".appShell")).toBeVisible();
  await waitUntilSynced(page);
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Odhlásit se" })).toBeVisible();
});

test("signing out without a connection is refused and removes nothing", async ({ page, context }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page.locator("p.formError")).toContainText("Server není dostupný");
  await expect(page.locator(".appShell")).toBeVisible();
  expect(await page.evaluate(() => indexedDB.databases().then((list) => list.some((database) => database.name === "ai-executive")))).toBe(true);
  await context.setOffline(false);
});

test("signing out clears the local copy; signing in again restores it from the server", async ({ page }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  const plantDraft = (text: string, base: string) => page.evaluate((draft) => localStorage.setItem("ai-executive-notes-drafts",
    JSON.stringify({ "other-tab:e2e-rename": { id: "e2e-rename", ...draft, at: Date.now(), page: "other-tab" } })), { text, base });
  const base = String((await serverEntities(page)).find((entity) => entity.id === "e2e-rename")?.properties?.notes ?? "");
  await settingsSections(page).filter({ hasText: "Přístup" }).click();
  // A draft from another tab that conflicts with newer notes is not sent; sign-out asks first.
  await plantDraft(`Zastaralé z jiné karty ${Date.now()}`, "jiný základ");
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).getByRole("button", { name: "Zrušit" }).click();
  await expect(page.locator(".appShell")).toBeVisible();
  await expect(page.locator(".authCard")).toHaveCount(0);
  // Notes still being typed in another tab are sent before the local copy is removed.
  const otherTab = `Z jiné karty před odhlášením ${Date.now()}`;
  await plantDraft(otherTab, base);
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  // Everything was sent, so no question about discarding changes may appear.
  await expect(page.locator(".authCard")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  const local = await page.evaluate(() => new Promise<string[]>((resolve) => {
    const request = indexedDB.open("ai-executive");
    request.onsuccess = () => {
      const all = request.result.transaction("entities").objectStore("entities").getAll();
      all.onsuccess = () => { resolve(all.result.map((entity: { title: string }) => entity.title)); request.result.close(); };
    };
  }));
  // Only the empty placeholder workspace may be there (it is created when the sign-in screen loads).
  expect(local.filter((title) => title !== "Personal")).toEqual([]);
  expect(await page.evaluate(() => fetch("/api/store").then((response) => response.status))).toBe(401);
  await signIn(page);
  await sidebarView(page, "Doručené").click();
  await expect(page.getByText(seeded.plainTask)).toBeVisible();
  await expectOnServer(page, (entity) => entity.id === "e2e-rename" && entity.properties?.notes === otherTab, true);
});
