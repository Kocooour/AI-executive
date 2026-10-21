import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

for (const width of [390, 1280]) {
  test(`Search filters accessible results and isolates workspaces at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await waitUntilSynced(page);
    const fixture = await page.evaluate(async () => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then(r => r.json());
      const now = Date.now();
      const token = `e2e-search-${now}-${Math.floor(Math.random() * 1e6)}`;
      const other = `${token}-workspace`;
      const entity = (id: string, type: string, title: string, workspaceId = "personal", content = "") => ({
        id, type, title, workspaceId, content, status: type === "task" ? "open" : "active",
        properties: {}, createdAt: now, updatedAt: now,
      });
      const workspace = { ...entity(`workspace:${other}`, "workspace", "E2E oddělený prostor", other),
        properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] } };
      const task = {
        ...entity(`task:${token}`, "task", `Objednat diagnostiku ${token}`),
        // The conflict is present in a canonical server record; this exercises
        // the real RecordMarks and its screen-reader announcement after reload.
        properties: { syncConflicts: [{ id: `conflict:${token}`, field: "title",
          lostValue: "Původní název", at: now }] },
      };
      const project = entity(`project:${token}`, "project", `Servisní projekt ${token}`);
      const note = entity(`note:${token}`, "note", `Poznámka ${token}`, "personal", "Záruka na zařízení");
      const hidden = entity(`other:${token}`, "note", `Servisní tajemství ${token}`, other);
      const rel = { id: `rel:${token}`, workspaceId: "personal",
        sourceEntityId: task.id, targetEntityId: project.id,
        relationType: "belongs_to_project", createdAt: now };
      const response = await fetch("/api/store", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
          entities: [...snapshot.entities, workspace, task, project, note, hidden],
          relations: [...snapshot.relations, rel], deletedIds: [], revivedIds: [],
        }),
      });
      if (!response.ok) throw new Error(`Search fixture failed: ${response.status}`);
      return { token, other, task: task.title, project: project.title, note: note.title, hidden: hidden.title };
    });
    await page.goto("/?view=Search");
    await waitUntilSynced(page);
    const search = page.getByRole("textbox", { name: "Hledat ve všem" });
    await expect(page.locator(".searchExplorer .searchState")).toContainText("Do pole nahoře");
    await search.fill(`servisni ${fixture.token}`);
    const results = page.locator(".searchExplorer .searchResults");
    // A visible relation in the same workspace can match the related task,
    // but the note in another workspace cannot appear in this view.
    await expect(results.locator("article")).toHaveCount(2);
    await expect(results).toContainText(fixture.project);
    await expect(results).toContainText(fixture.task);
    await expect(results).not.toContainText(fixture.hidden);
    await expect(results.locator('article[data-match-source="related"]')).toContainText(fixture.task);

    const filter = page.locator('.searchKindFilters [data-search-kind="task"]');
    await expect(filter).toHaveAttribute("aria-pressed", "false");
    await filter.click();
    await expect(filter).toHaveAttribute("aria-pressed", "true");
    await expect(results.locator("article")).toHaveCount(1);
    await expect(results).toContainText(fixture.task);
    await page.locator('.searchKindFilters [data-search-kind="note"]').click();
    await expect(page.locator(".searchState")).toContainText("nebyla nalezena");
    await page.getByRole("button", { name: "Zobrazit všechny typy" }).click();
    await expect(results.locator("article")).toHaveCount(2);

    const relatedTask = results.getByRole("button", {
      name: `Otevřít ${fixture.task} · Úkol · Shoda v související položce · Změněno i na jiném zařízení`,
      exact: true,
    });
    await expect(relatedTask).toHaveAccessibleName(
      `Otevřít ${fixture.task} · Úkol · Shoda v související položce · Změněno i na jiném zařízení`);
    await expect(results.locator('[data-match-source="related"] .conflictMark'))
      .toHaveAttribute("aria-label", "Změněno i na jiném zařízení");
    await relatedTask.click();
    await expect(page.locator(".detail")).toBeVisible();
    if (width === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await filter.evaluate(x => x.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
  });
}

test("Search announces a local-only task when saving is unavailable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `E2E lokálně čekající úkol ${Date.now()}`;
  // Let Quick Capture persist locally but never acknowledge a server write.
  await page.route("**/api/task-suggestions", route => route.fulfill({
    status: 503, contentType: "application/json", body: '{"error":"unavailable"}',
  }));
  await page.route("**/api/store", route =>
    route.request().method() === "PUT" ? route.abort("failed") : route.continue());
  await page.locator(".mobileCaptureButton").click();
  const capture = page.locator(".captureModal");
  await capture.getByRole("textbox", { name: "Název úkolu" }).fill(title);
  await expect(capture.locator(".captureSuggestionState.error")).toBeVisible();
  await capture.getByRole("button", { name: "Přidat úkol" }).click();
  await expect(capture).toHaveCount(0);
  await page.getByRole("textbox", { name: "Hledat ve všem" }).fill(title);
  const pending = page.locator(".searchExplorer").getByRole("button", {
    name: `Otevřít ${title} · Úkol · Čeká na uložení`, exact: true,
  });
  await expect(pending).toHaveAccessibleName(`Otevřít ${title} · Úkol · Čeká na uložení`);
  await expect(pending.locator(".unsentMark")).toHaveAttribute("aria-label", "Čeká na uložení");
});
