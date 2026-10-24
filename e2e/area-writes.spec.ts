import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { removeTasks, sidebarView, waitUntilSynced } from "./helpers";

// 2a part 4: every new write keeps the Area model. A task in a project has no Area of its own and shows the project's
// read-only; a standalone task (Quick Capture) is filed under the workspace's fallback Area "Nezařazeno".

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const serverStore = (page: Page) => page.evaluate(async () => fetch("/api/store", { cache: "no-store" }).then((response) => response.json()));

test("a task in a project shows the project's area read-only; a Quick Capture task is filed under Nezařazeno", async ({ page }) => {
  const id = stamp();
  const ids = { area: `e2e-aw-area-${id}`, project: `e2e-aw-project-${id}`, task: `e2e-aw-task-${id}` };
  const names = { area: `Oblast AW ${id}`, project: `Projekt AW ${id}`, task: `Úkol v projektu AW ${id}`, captured: `Zachycený úkol AW ${id}` };
  await page.goto("/");
  await waitUntilSynced(page);
  await expect.poll(() => page.evaluate(async ({ ids, names }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const record = (recordId: string, type: string, title: string, properties: Record<string, unknown> = {}) =>
      ({ id: recordId, type, title, status: type === "task" ? "open" : "active", workspaceId: "personal", properties, createdAt: now, updatedAt: now });
    const link = (suffix: string, source: string, target: string, relationType: string) =>
      ({ id: `e2e-aw-${suffix}-${now}`, sourceEntityId: source, targetEntityId: target, relationType, workspaceId: "personal", createdAt: now });
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
      entities: [...snapshot.entities, record(ids.area, "area", names.area, { kind: "private" }), record(ids.project, "project", names.project),
        record(ids.task, "task", names.task, { inbox: false })],
      relations: [...snapshot.relations, link("pa", ids.project, ids.area, "belongs_to_area"), link("tp", ids.task, ids.project, "belongs_to_project")],
      deletedIds: [], revivedIds: [] }) });
    return response.status;
  }, { ids, names }), { timeout: 15_000 }).toBe(200);
  let capturedId = "";
  try {
    // 1. The task in the project: the inherited Area as text, no select to change it.
    await page.goto("/?view=Projects");
    await waitUntilSynced(page);
    await page.locator("article", { hasText: names.project }).first().click();
    await page.locator(".projectPage").getByText(names.task).first().click();
    const detail = page.locator("aside.detail");
    await expect(detail.getByTestId("inherited-area")).toHaveText(`Oblast: ${names.area} (z projektu)`);
    await expect(detail.getByLabel("Oblast", { exact: true })).toHaveCount(0);
    const projectSelect = detail.locator("select").filter({ has: page.locator(`option[value="${ids.project}"]`) });
    await expect(projectSelect).toHaveValue(ids.project);

    // 2. Quick Capture: the dialog names the fallback Area, the stored task has exactly that one.
    await page.goto("/");
    await waitUntilSynced(page);
    await page.route("**/api/task-suggestions", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    await page.locator("button", { hasText: "＋" }).first().click();
    const modal = page.locator(".captureModal");
    await modal.getByLabel("Název úkolu").fill(names.captured);
    await expect(modal.getByLabel("Oblast").locator("option:checked")).toHaveText("Nezařazeno");
    await modal.getByRole("button", { name: "Přidat úkol" }).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(async () => {
      const store = await serverStore(page);
      const task = store.entities.find((entity: { title: string }) => entity.title === names.captured);
      if (!task) return null;
      capturedId = task.id;
      const areas = store.relations.filter((relation: { sourceEntityId: string; relationType: string }) => relation.sourceEntityId === task.id && relation.relationType === "belongs_to_area");
      const area = store.entities.find((entity: { id: string }) => entity.id === areas[0]?.targetEntityId);
      return { links: areas.length, title: area?.title, kind: area?.properties?.kind };
    }, { timeout: 20_000 }).toEqual({ links: 1, title: "Nezařazeno", kind: "private" });
    await page.goto("/?view=Inbox");
    await sidebarView(page, "Doručené").click();
    await page.locator("article", { hasText: names.captured }).first().click();
    await expect(page.locator("aside.detail").getByLabel("Oblast", { exact: true }).locator("option:checked")).toHaveText("Nezařazeno");
    await expect(page.locator("aside.detail").getByLabel("Oblast", { exact: true }).locator("option[value='']")).toHaveCount(0);

    // 3. Moving the captured task into the project drops its own Area link; it then shows the project's.
    await page.locator("aside.detail").locator("select:not([aria-label])").filter({ has: page.locator(`option[value="${ids.project}"]`) }).selectOption(ids.project);
    await expect.poll(async () => {
      const store = await serverStore(page);
      return store.relations.filter((relation: { sourceEntityId: string; relationType: string }) => relation.sourceEntityId === capturedId && relation.relationType === "belongs_to_area").length;
    }, { timeout: 20_000 }).toBe(0);
    await expect(page.locator("aside.detail").getByTestId("inherited-area")).toHaveText(`Oblast: ${names.area} (z projektu)`);
  } finally {
    const store = await serverStore(page);
    const gone = [ids.area, ids.project, ids.task,
      ...store.entities.filter((entity: { title: string }) => entity.title === names.captured).map((entity: { id: string }) => entity.id)];
    await removeTasks(page, [...new Set(gone)]);
  }
});
