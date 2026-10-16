import { expect, test } from "./fixtures";
import { expectOnServer, waitUntilSynced } from "./helpers";

async function seedNote(page: import("@playwright/test").Page, id: string, title: string, content = "") {
  await page.evaluate(async ([noteId, noteTitle, noteContent]) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: [...snapshot.entities, { id: noteId, type: "note", title: noteTitle, content: noteContent, status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now }],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  }, [id, title, content]);
}

async function openNote(page: import("@playwright/test").Page, id: string) {
  await page.goto("/");
  await waitUntilSynced(page);
  await page.goto(`/?task=${id}`);
  await expect(page.getByLabel("Text poznámky").first()).toBeVisible();
  await waitUntilSynced(page);
}

const serverContent = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate((noteId) => fetch("/api/store", { cache: "no-store" }).then((response) => response.json())
    .then((snapshot) => (snapshot.entities.find((entity: { id: string }) => entity.id === noteId) as { content?: string } | undefined)?.content), id);

test("a note body is edited, saved on leaving the field and previewed as safe Markdown", async ({ page }) => {
  const id = `e2e-note-body-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Neutral note");
  const requested: string[] = [];
  page.on("request", (request) => { if (request.url().includes("e2e-image-probe")) requested.push(request.url()); });
  await openNote(page, id);
  const body = "# Heading one\n\n- first item\n- second item\n\n- [ ] open box\n- [x] done box\n\n<script>window.__probe = 1</script>\n\n<img src=\"/e2e-image-probe.png\" onerror=\"window.__probe = 2\">\n\n![alt words](/e2e-image-probe.png)\n\n[bad](javascript:window.__probe=3) and [good](https://example.com)";
  const field = page.getByLabel("Text poznámky").first();
  await field.fill(body);
  await page.locator("input.titleEdit").focus();
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe(body);
  await expect(page.locator(".noteStatus[data-state]")).toHaveText("Uloženo", { timeout: 20_000 });
  await page.getByRole("button", { name: "Náhled" }).click();
  const preview = page.locator(".markdownText").first();
  await expect(preview.getByRole("heading", { name: "Heading one" })).toBeVisible();
  await expect(preview.locator("ul li")).toHaveCount(4);
  await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(preview.locator("img, script")).toHaveCount(0);
  await expect(preview).toContainText("[alt words]");
  await expect(preview.getByRole("link", { name: "good" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(preview.getByRole("link", { name: "good" })).toHaveAttribute("target", "_blank");
  await expect(preview.getByRole("link", { name: "bad" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __probe?: number }).__probe)).toBeUndefined();
  expect(requested).toEqual([]);
  await expect(page.getByRole("button", { name: "Náhled" })).toHaveAttribute("aria-pressed", "true");
});

test("the version history lists versions with changes, shows a diff and restores a version as a new one", async ({ page }) => {
  const id = `e2e-note-history-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "History note", "first line\nshared line");
  await openNote(page, id);
  const list = page.locator(".revisionList");
  await expect(list.locator("li")).toHaveCount(1, { timeout: 20_000 });
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("first line\nshared line\nadded line");
  await page.locator("input.titleEdit").focus();
  await expect(list.locator("li")).toHaveCount(2, { timeout: 20_000 });
  await field.fill("changed text");
  await page.locator("input.titleEdit").focus();
  await expect(list.locator("li")).toHaveCount(3, { timeout: 20_000 });
  await expect(list.locator("li").first()).toContainText("Verze 3");
  await expect(list.locator("li").first()).toContainText("znaků");
  // The oldest version is shown against the current text with marked lines.
  await list.locator("li").last().getByRole("button").click();
  const diff = page.locator(".revisionDiff");
  await expect(diff).toContainText("- first line");
  await expect(diff).toContainText("- shared line");
  await expect(diff).toContainText("+ changed text");
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await expect(page.locator(".noteStatus", { hasText: "Předchozí text zůstává uložen" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe("first line\nshared line");
  await expect(list.locator("li")).toHaveCount(4, { timeout: 20_000 });
  await expect(list.locator("li").first()).toContainText("Verze 4");
  await expect(list.locator("li").first()).toContainText("stejný text jako verze 1");
  await expect(field).toHaveValue("first line\nshared line");
  // Restoring the version that is already the text writes nothing, and an older version can still be restored afterwards.
  await list.locator("li").first().getByRole("button").click();
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await expect(page.locator(".noteStatus", { hasText: "Tato verze je už aktuální text." })).toBeVisible();
  await expect(list.locator("li")).toHaveCount(4);
  await list.locator("li", { hasText: "Verze 3" }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "Obnovit tuto verzi" })).toBeEnabled({ timeout: 20_000 });
});

test("a version cannot be restored while the latest change has not reached the server", async ({ page }) => {
  const id = `e2e-note-unsent-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Unsent note", "server text");
  await openNote(page, id);
  const list = page.locator(".revisionList");
  await expect(list.locator("li")).toHaveCount(1, { timeout: 20_000 });
  await list.locator("li").first().getByRole("button").click();
  await expect(page.getByRole("button", { name: "Obnovit tuto verzi" })).toBeEnabled({ timeout: 20_000 });
  // Saves are held back, as without a connection: the edit stays waiting in this device.
  await page.route("**/api/store", (route) => route.request().method() === "PUT" ? route.abort() : route.continue());
  await page.getByLabel("Text poznámky").first().fill("typed while the server is unreachable");
  await page.locator("input.titleEdit").focus();
  await expect(page.getByRole("button", { name: "Obnovit tuto verzi" })).toBeDisabled({ timeout: 20_000 });
  await expect(page.locator(".noteStatus", { hasText: "Poslední změna ještě nedorazila na server" })).toBeVisible();
  expect(await serverContent(page, id)).toBe("server text");
  await page.unroute("**/api/store");
});

test("a note body typed but not yet saved survives a reload", async ({ page }) => {
  const id = `e2e-note-draft-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Draft note", "start");
  await openNote(page, id);
  const typed = `typed before reload ${Date.now()}`;
  await page.getByLabel("Text poznámky").first().fill(typed);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ai-executive-notes-drafts:")).length)).toBeGreaterThan(0);
  await page.reload();
  await page.goto(`/?task=${id}`);
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue(typed, { timeout: 20_000 });
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe(typed);
});

test("the note editor fits a phone width and its buttons are large enough", async ({ page }) => {
  const id = `e2e-note-layout-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Layout note", "a very long line ".repeat(20) + "\n\n```\n" + "x".repeat(200) + "\n```");
  await page.setViewportSize({ width: 390, height: 844 });
  await openNote(page, id);
  await expect(page.locator(".revisionList li")).toHaveCount(1, { timeout: 20_000 });
  await page.getByRole("button", { name: "Náhled" }).click();
  await page.locator(".revisionList li button").first().click();
  await expect(page.locator(".revisionDiff")).toBeVisible();
  const metrics = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    detail: (document.querySelector(".detail") as HTMLElement).scrollWidth - (document.querySelector(".detail") as HTMLElement).clientWidth,
    buttons: [...document.querySelectorAll(".noteModeToggle button, .revisionList button, .revisionRestore")].map((element) => element.getBoundingClientRect().height),
  }));
  expect(metrics.page).toBeLessThanOrEqual(0);
  expect(metrics.detail).toBeLessThanOrEqual(0);
  for (const height of metrics.buttons) expect(height).toBeGreaterThanOrEqual(44);
});

// Another device saves the note while this page still holds typed, unsaved text.
async function otherDeviceSaves(page: import("@playwright/test").Page, id: string, content: string) {
  await page.evaluate(async ([noteId, text]) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const entities = snapshot.entities.map((entity: { id: string }) => (entity.id === noteId ? { ...entity, content: text, updatedAt: Date.now() + 5000 } : entity));
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, entities, relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  }, [id, content]);
}

test("unsaved note text never overwrites newer text from another device; the owner chooses", async ({ page }) => {
  const id = `e2e-note-conflict-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Conflict note", "base text v1");
  await openNote(page, id);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("my unsaved text");
  await otherDeviceSaves(page, id, "other device v2");
  // The app takes over the newer server copy (as on focus), then the field is left.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.reload();
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const conflict = page.locator(".noteConflict");
  await expect(conflict).toBeVisible({ timeout: 20_000 });
  await expect(conflict).toContainText("změněn na jiném zařízení");
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue("my unsaved text");
  expect(await serverContent(page, id)).toBe("other device v2");
  await page.locator("input.titleEdit").focus();
  await page.waitForTimeout(500);
  expect(await serverContent(page, id)).toBe("other device v2");
  // Using my text saves it; the other text stays in the history.
  await conflict.getByRole("button", { name: "Použít můj text" }).click();
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe("my unsaved text");
  await expect(page.locator(".noteConflict")).toHaveCount(0);
  await page.locator(".revisionList li").last().waitFor({ timeout: 20_000 });
  await expect(page.locator(".revisionList li")).toHaveCount(3, { timeout: 20_000 });
  await page.locator(".revisionList li", { hasText: "Verze 2" }).getByRole("button").click();
  await expect(page.locator(".revisionDetail")).toContainText("other device v2");
});

// Opens a note from the Notes list without reloading the page, as a person does.
async function switchToNote(page: import("@playwright/test").Page, title: string) {
  await page.evaluate(() => { history.pushState(null, "", "/?view=Notes"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await page.locator("main").getByText(title, { exact: true }).first().click();
  await expect(page.getByLabel("Text poznámky").first()).toBeVisible();
}

test("a conflict found when leaving the field survives opening another note and coming back", async ({ page }) => {
  const stamp = Date.now();
  const a = `e2e-note-keep-a-${stamp}`;
  const b = `e2e-note-keep-b-${stamp}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, a, "Keep A", "a base");
  await seedNote(page, b, "Keep B", "b base");
  await openNote(page, a);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("a unsaved");
  await otherDeviceSaves(page, a, "a newer elsewhere");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitUntilSynced(page);
  await page.locator("input.titleEdit").focus();
  await expect(page.locator(".noteConflict")).toBeVisible({ timeout: 20_000 });
  expect(await serverContent(page, a)).toBe("a newer elsewhere");
  // Another note is opened and edited in the same page; the first note's unresolved text is not lost.
  await switchToNote(page, "Keep B");
  await expect(field).toHaveValue("b base", { timeout: 20_000 });
  await field.fill("b edited");
  await page.locator("input.titleEdit").focus();
  await expect.poll(() => serverContent(page, b), { timeout: 20_000 }).toBe("b edited");
  await switchToNote(page, "Keep A");
  await expect(page.locator(".noteConflict")).toBeVisible({ timeout: 20_000 });
  await expect(field).toHaveValue("a unsaved");
  expect(await serverContent(page, a)).toBe("a newer elsewhere");
});

test("text typed into a note that another device deletes meanwhile is kept, not lost", async ({ page }) => {
  const id = `e2e-note-deleted-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Deleted elsewhere", "before");
  await openNote(page, id);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("typed before it was deleted");
  await page.evaluate(async (noteId) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: snapshot.entities.filter((entity: { id: string }) => entity.id !== noteId), relations: snapshot.relations, deletedIds: [noteId], revivedIds: [] }) });
  }, id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitUntilSynced(page);
  await page.locator("input.titleEdit").focus().catch(() => undefined);
  await page.mouse.click(5, 5);
  // The text is not thrown away: it stays kept in this device.
  await expect.poll(() => page.evaluate((noteId) => Object.keys(localStorage).some((key) => key.endsWith(`note-body:${noteId}`)
    && JSON.parse(localStorage.getItem(key) || "{}").text === "typed before it was deleted"), id), { timeout: 20_000 }).toBe(true);
});

test("finishing a slow restore of one note does not touch the text being typed in another", async ({ page }) => {
  const stamp = Date.now();
  const a = `e2e-note-restore-a-${stamp}`;
  const b = `e2e-note-restore-b-${stamp}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, a, "Restore A", "a one");
  await seedNote(page, b, "Restore B", "b base");
  await openNote(page, a);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("a two");
  await page.locator("input.titleEdit").focus();
  const list = page.locator(".revisionList");
  await expect(list.locator("li")).toHaveCount(2, { timeout: 20_000 });
  await list.locator("li", { hasText: "Verze 1" }).getByRole("button").click();
  // The restore's save is held for a while, during which note B is opened and typed into.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/store", async (route) => { if (route.request().method() === "PUT") await held; await route.continue(); });
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  // The restore is still running (its save is held) when note B is opened.
  await expect(page.getByRole("button", { name: "Obnovit tuto verzi" })).toBeDisabled();
  await switchToNote(page, "Restore B");
  await field.fill("b typed during the restore");
  release();
  await expect.poll(() => serverContent(page, a), { timeout: 20_000 }).toBe("a one");
  await page.unroute("**/api/store");
  await page.waitForTimeout(1000);
  await expect(field).toHaveValue("b typed during the restore");
  // B's text is still known as unsaved (not reported as saved, and it is sent when the field is left).
  await expect(page.locator(".noteStatus[data-state]")).toHaveAttribute("data-state", "noteUnsaved");
  expect(await page.evaluate((noteId) => Object.keys(localStorage).some((key) => key.endsWith(`note-body:${noteId}`)
    && JSON.parse(localStorage.getItem(key) || "{}").text === "b typed during the restore"), b)).toBe(true);
});

test("a draft left by a closed page never replaces the text being typed in the same note", async ({ page }) => {
  const id = `e2e-note-live-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Live note", "server text");
  await openNote(page, id);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("live typing");
  // A closed page left a draft of the same note that no longer fits the note's text (a conflict).
  await page.evaluate((noteId) => localStorage.setItem(`ai-executive-notes-drafts:closed-page:note-body:${noteId}`,
    JSON.stringify({ id: `note-body:${noteId}`, text: "left by a closed page", base: "older text", at: Date.now() - 120_000, page: "closed-page" })), id);
  // A failed and then successful synchronization runs the recovery of left drafts again.
  await page.route("**/api/store", (route) => route.request().method() === "GET" ? route.abort() : route.continue());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(1500);
  await page.unroute("**/api/store");
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
  await waitUntilSynced(page);
  await page.waitForTimeout(2000);
  await expect(field).toHaveValue("live typing");
  const kept = await page.evaluate((noteId) => Object.keys(localStorage).filter((key) => key.endsWith(`note-body:${noteId}`))
    .map((key) => JSON.parse(localStorage.getItem(key) || "{}").text).sort(), id);
  expect(kept).toEqual(["left by a closed page", "live typing"]);
});

test("without device storage, unsaved text of one note survives editing another note", async ({ page }) => {
  // Device storage refuses note drafts, as when it is full.
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.includes("note-body:")) throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  const stamp = Date.now();
  const a = `e2e-note-memory-a-${stamp}`;
  const b = `e2e-note-memory-b-${stamp}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, a, "Memory A", "a base");
  await seedNote(page, b, "Memory B", "b base");
  await openNote(page, a);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("a unsaved in memory");
  await otherDeviceSaves(page, a, "a newer elsewhere");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitUntilSynced(page);
  await page.locator("input.titleEdit").focus();
  await expect(page.locator(".noteConflict")).toBeVisible({ timeout: 20_000 });
  await switchToNote(page, "Memory B");
  await field.fill("b edited");
  await page.locator("input.titleEdit").focus();
  await expect.poll(() => serverContent(page, b), { timeout: 20_000 }).toBe("b edited");
  await switchToNote(page, "Memory A");
  await expect(field).toHaveValue("a unsaved in memory", { timeout: 20_000 });
  await expect(page.locator(".noteConflict")).toBeVisible();
  expect(await serverContent(page, a)).toBe("a newer elsewhere");
});

async function otherDeviceDeletes(page: import("@playwright/test").Page, id: string) {
  await page.evaluate(async (noteId) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: snapshot.entities.filter((entity: { id: string }) => entity.id !== noteId), relations: snapshot.relations, deletedIds: [noteId], revivedIds: [] }) });
  }, id);
}
const keptBodyText = (page: import("@playwright/test").Page, id: string) => page.evaluate((noteId) => Object.keys(localStorage)
  .filter((key) => key.endsWith(`note-body:${noteId}`)).map((key) => JSON.parse(localStorage.getItem(key) || "{}").text), id);

test("a crashed page's text for a note deleted elsewhere is kept in the device", async ({ page }) => {
  const id = `e2e-note-crash-gone-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Crash gone", "base");
  await page.evaluate((noteId) => localStorage.setItem(`ai-executive-notes-drafts:crashed-page:note-body:${noteId}`,
    JSON.stringify({ id: `note-body:${noteId}`, text: "typed before the crash", base: "base", at: Date.now() - 120_000, page: "crashed-page" })), id);
  await otherDeviceDeletes(page, id);
  await page.reload();
  await waitUntilSynced(page);
  await page.waitForTimeout(2000);
  expect(await keptBodyText(page, id)).toEqual(["typed before the crash"]);
});

test("using my text when the note was deleted elsewhere keeps the text", async ({ page }) => {
  const id = `e2e-note-mine-gone-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Mine gone", "base");
  await openNote(page, id);
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("my text");
  await otherDeviceSaves(page, id, "newer elsewhere");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitUntilSynced(page);
  await page.locator("input.titleEdit").focus();
  const conflict = page.locator(".noteConflict");
  await expect(conflict).toBeVisible({ timeout: 20_000 });
  await otherDeviceDeletes(page, id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitUntilSynced(page);
  await conflict.getByRole("button", { name: "Použít můj text" }).click();
  await expect(page.locator(".noteStatus[data-state]")).toHaveAttribute("data-state", "noteSaveFailed", { timeout: 20_000 });
  expect(await keptBodyText(page, id)).toEqual(["my text"]);
});

test("discarding my text in a conflict shows the stored text", async ({ page }) => {
  const id = `e2e-note-discard-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Discard note", "base text v1");
  await openNote(page, id);
  await page.getByLabel("Text poznámky").first().fill("typed text to drop");
  await otherDeviceSaves(page, id, "newer elsewhere");
  await page.reload();
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  await expect(page.locator(".noteConflict")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Zahodit můj text" }).click();
  await expect(page.locator(".noteConflict")).toHaveCount(0);
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue("newer elsewhere");
  expect(await serverContent(page, id)).toBe("newer elsewhere");
});

test("a draft left by a crashed page whose note changed meanwhile stays visible as a conflict", async ({ page }) => {
  const id = `e2e-note-crashed-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Crashed note", "server text now");
  await page.evaluate((noteId) => {
    localStorage.setItem(`ai-executive-notes-drafts:old-page-crashed:note-body:${noteId}`, JSON.stringify({
      id: `note-body:${noteId}`, text: "typed on crashed page", base: "base text v1", at: Date.now(), page: "old-page-crashed" }));
  }, id);
  await page.reload();
  await waitUntilSynced(page);
  await page.goto(`/?task=${id}`);
  await expect(page.locator(".noteConflict")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue("typed on crashed page");
  // Still there after another reload (it was adopted by this page, not deleted).
  await page.reload();
  await waitUntilSynced(page);
  await page.goto(`/?task=${id}`);
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue("typed on crashed page", { timeout: 20_000 });
  await expect(page.locator(".noteConflict")).toBeVisible();
  expect(await serverContent(page, id)).toBe("server text now");
});
