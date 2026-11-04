import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";
import type { Page } from "@playwright/test";

// Preview-only coverage: uses the normal synthetic legacy store and cleans up.
async function storeChange(page: Page, entities: Record<string, unknown>[], relations: Record<string, unknown>[], remove: string[] = []) {
  await expect.poll(async () => page.evaluate(async ({ entities, relations, remove }) => {
    const gone = new Set(remove);
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities.filter((e: { id: string }) => !gone.has(e.id)), ...entities],
        relations: [...snapshot.relations.filter((r: { sourceEntityId: string; targetEntityId: string }) =>
          !gone.has(r.sourceEntityId) && !gone.has(r.targetEntityId)), ...relations],
        deletedIds: remove, revivedIds: [],
      }) });
    return response.status;
  }, { entities, relations, remove }), { timeout: 15_000 }).toBe(200);
}

test("gated mobile detail puts tasks before collapsible context, preserving edit draft and desktop", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile Design v1 preview disabled");
  const stamp = Date.now().toString(36);
  const id = { area: `ui05b-area-${stamp}`, project: `ui05b-project-${stamp}`,
    task: `ui05b-task-${stamp}`, note: `ui05b-note-${stamp}` };
  const now = Date.now();
  const entity = (key: keyof typeof id, type: string, title: string, status: string) =>
    ({ id: id[key], type, title, status, workspaceId: "personal", properties: {},
      createdAt: now, updatedAt: now });
  const entities = [
    entity("area", "area", `Rodina UI05b ${stamp}`, "active"),
    entity("project", "project", `Příprava výletu ${stamp}`, "active"),
    entity("task", "task", `Domluvit dopravu ${stamp}`, "open"),
    entity("note", "note", `Podklady pro cestu ${stamp}`, "active"),
  ];
  const relation = (source: string, target: string, type: string) => ({
    id: `rel-${source}-${target}`, sourceEntityId: source, targetEntityId: target,
    relationType: type, workspaceId: "personal", createdAt: now,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await storeChange(page, entities, [
    relation(id.project, id.area, "belongs_to_area"),
    relation(id.task, id.project, "belongs_to_project"),
    relation(id.note, id.project, "belongs_to_project"),
  ]);
  try {
    await page.reload(); await waitUntilSynced(page);
    await page.locator(`[data-project-preview-row="${id.project}"] .v1ProjectName button`).click();
    const project = page.locator(`[data-project-page="${id.project}"]`);
    await expect(project).toHaveAttribute("data-project-detail-preview", "lumi-v1");
    const tasks = project.locator(".projectTaskList");
    const context = project.locator("[data-project-context-fold]");
    const notes = project.locator(".projectNoteList");
    await expect(tasks.getByText(`Domluvit dopravu ${stamp}`)).toBeVisible();
    await expect(notes.getByText(`Podklady pro cestu ${stamp}`)).toBeVisible();
    await expect(context).not.toHaveAttribute("open", "");
    await expect(project.locator(".projectHeader .projectContext")).toHaveCount(0);
    expect(await project.evaluate((element) => {
      const order = [".projectHeader", ".projectTaskList", "[data-project-context-fold]", ".projectNoteList", "[data-project-details]"];
      const nodes = order.map((selector) => element.querySelector(selector));
      for (let i = 1; i < nodes.length; i += 1) {
        const previous = nodes[i - 1];
        const next = nodes[i];
        if (!previous || !next || !(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      }
      return nodes.every((node) => node !== null);
    })).toBe(true);
    // Native details must also work with keyboard only, not require a touch gesture.
    const contextSummary = context.locator("summary");
    await contextSummary.focus();
    await expect(contextSummary).toBeFocused();
    await contextSummary.press("Enter");
    await expect(context).toHaveAttribute("open", "");
    const why = context.getByRole("textbox", { name: "Proč je důležitý" });
    await why.fill(`Rozepsaný důvod UI05b ${stamp}`);
    // ProjectContext persists every keystroke in a guarded local draft. It
    // must recover when the responsive preview returns to the desktop editor.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(project).not.toHaveAttribute("data-project-detail-preview", "lumi-v1");
    await expect(project.locator(".projectHeader .projectContext")).toBeVisible();
    await expect(project.locator(".projectHeader .projectContext").getByRole("textbox", { name: "Proč je důležitý" }))
      .toHaveValue(`Rozepsaný důvod UI05b ${stamp}`);
    await expect(project.locator("[data-project-context-fold]")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(project).toHaveAttribute("data-project-detail-preview", "lumi-v1");
    await project.locator("[data-project-context-fold] summary").click();
    await expect(project.locator("[data-project-context-fold]").getByRole("textbox", { name: "Proč je důležitý" }))
      .toHaveValue(`Rozepsaný důvod UI05b ${stamp}`);
    await expect(project.locator(".projectDetails")).not.toHaveAttribute("open", "");
    await expect(project.locator(".projectHeader .projectActions")).toHaveCount(0);
  } finally {
    await storeChange(page, [], [], Object.values(id));
  }
});

test("mobile project completion in Details requires confirmation and preserves open child tasks", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile Design v1 preview disabled");
  const stamp = Date.now().toString(36);
  const projectId = `ui05b-project-status-${stamp}`, taskId = `ui05b-child-status-${stamp}`;
  const now = Date.now();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects"); await waitUntilSynced(page);
  await storeChange(page, [
    { id: projectId, type: "project", title: `Projekt UI05b ${stamp}`, status: "active",
      workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now },
    { id: taskId, type: "task", title: `Otevřený úkol UI05b ${stamp}`, status: "open",
      workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now },
  ], [{ id: `rel-${stamp}`, sourceEntityId: taskId, targetEntityId: projectId,
    relationType: "belongs_to_project", workspaceId: "personal", createdAt: now }]);
  try {
    await page.reload(); await waitUntilSynced(page);
    await page.locator(`[data-project-preview-row="${projectId}"] .v1ProjectName button`).click();
    const detail = page.locator(`[data-project-page="${projectId}"]`);
    await detail.locator(".projectDetails summary").click();
    const button = detail.locator(".projectDetails .projectActions button").first();
    await button.click();
    const dialog = page.locator("dialog.confirmDialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1 otevřený úkol");
    await expect(dialog).toContainText("stav těchto úkolů nezmění");
    await dialog.getByRole("button", { name: "Zrušit" }).click();
    await expect(detail.getByTestId("project-status")).toContainText("Aktivní");
    await button.click();
    await dialog.getByRole("button", { name: "Dokončit", exact: true }).click();
    await expect(detail.getByTestId("project-status")).toContainText("Dokončený");
    await expect.poll(() => page.evaluate(async ({ projectId, taskId }) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
      return [snapshot.entities.find((e: { id: string }) => e.id === projectId)?.status,
        snapshot.entities.find((e: { id: string }) => e.id === taskId)?.status];
    }, { projectId, taskId })).toEqual(["completed", "open"]);
  } finally {
    await storeChange(page, [], [], [projectId, taskId]);
  }
});
