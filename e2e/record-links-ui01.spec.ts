import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";

// UI-01b: focused browser regression only; full E2E is a pre-deployment gate.
async function updateStore(page: Page, records: Array<Record<string, unknown>>, links: Array<Record<string, unknown>>, remove = false) {
  return page.evaluate(async ({ records, links, remove }) => {
    const ids = new Set(records.map((item) => item.id));
    const relationIds = new Set(links.map((item) => item.id));
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const response = await fetch("/api/store", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
          entities: [...snapshot.entities.filter((item: { id: string }) => !ids.has(item.id)), ...(!remove ? records : [])],
          relations: [...snapshot.relations.filter((item: { id: string; sourceEntityId: string; targetEntityId: string }) =>
            !relationIds.has(item.id) && (!remove || (!ids.has(item.sourceEntityId) && !ids.has(item.targetEntityId)))),
            ...(!remove ? links : [])],
          deletedIds: remove ? [...ids] : [], revivedIds: [],
        }),
      });
      if (response.status !== 409) return response.status;
    }
    return 409;
  }, { records, links, remove });
}

function scenario() {
  const stamp = Date.now();
  const projectId = `ui01b-project-${stamp}`, taskId = `ui01b-task-${stamp}`,
    noteId = `ui01b-note-${stamp}`;
  const projectTitle = `UI01b projekt ${stamp}`, taskTitle = `UI01b úkol ${stamp}`,
    noteTitle = `UI01b poznámka ${stamp}`;
  const entity = (id: string, type: string, title: string) =>
    ({ id, type, title, status: type === "task" ? "open" : "active", workspaceId: "personal",
      properties: {}, createdAt: stamp, updatedAt: stamp });
  return {
    projectId, taskId, noteId, projectTitle, taskTitle, noteTitle,
    records: [entity(projectId, "project", projectTitle), entity(taskId, "task", taskTitle), entity(noteId, "note", noteTitle)],
    links: [
      { id: `ui01b-rel-task-${stamp}`, sourceEntityId: taskId, targetEntityId: projectId,
        relationType: "belongs_to_project", workspaceId: "personal", createdAt: stamp },
      { id: `ui01b-rel-note-${stamp}`, sourceEntityId: noteId, targetEntityId: projectId,
        relationType: "belongs_to_project", workspaceId: "personal", createdAt: stamp },
    ],
  };
}

test("project task inspector URL survives reload, Back and Forward", async ({ page }) => {
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const data = scenario();
  expect(await updateStore(page, data.records, data.links)).toBe(200);
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: data.projectTitle })
      .getByRole("button", { name: data.projectTitle, exact: true }).click();
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", data.projectId);
    await page.locator(".projectTaskList .taskRow", { hasText: data.taskTitle })
      .getByRole("button", { name: data.taskTitle, exact: true }).click();
    await expect(page.locator(".inspectorDetail")).toContainText(data.taskTitle);
    await expect(page).toHaveURL(new RegExp(`[?]view=Projects&projectId=${data.projectId}&taskId=${data.taskId}$`));

    await page.reload();
    await waitUntilSynced(page);
    await expect(page.locator(".inspectorDetail")).toContainText(data.taskTitle);
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", data.projectId);
    await page.goBack();
    await expect(page.locator(".inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", data.projectId);
    await page.goForward();
    await expect(page.locator(".inspectorDetail")).toContainText(data.taskTitle);
    await page.locator(".inspectorClose").click();
    await expect(page.locator(".inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", data.projectId);
  } finally {
    expect(await updateStore(page, data.records, data.links, true)).toBe(200);
  }
});

test("note direct link reloads independently; direct Close is a safe list fallback", async ({ page }) => {
  await page.goto("/?view=Notes");
  await waitUntilSynced(page);
  const data = scenario();
  expect(await updateStore(page, data.records, data.links)).toBe(200);
  try {
    await page.goto(`/?view=Notes&noteId=${data.noteId}`);
    await waitUntilSynced(page);
    await expect(page.locator(".inspectorDetail")).toContainText(data.noteTitle);
    await expect(page).toHaveURL(new RegExp(`[?]view=Notes&noteId=${data.noteId}$`));
    await page.reload();
    await waitUntilSynced(page);
    await expect(page.locator(".inspectorDetail")).toContainText(data.noteTitle);
    await page.locator(".inspectorClose").click();
    await expect(page.locator(".inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/[?]view=Notes$/);
    // A task ID must never open the unrelated note inspector.
    await page.goto(`/?view=Notes&noteId=${data.taskId}`);
    await waitUntilSynced(page);
    await expect(page.locator(".inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/[?]view=Notes$/);
    // A forged project parent may not reveal the record or the parent.
    await page.goto(`/?view=Projects&projectId=${data.taskId}&noteId=${data.noteId}`);
    await waitUntilSynced(page);
    await expect(page.locator(".inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".projectPage")).toHaveCount(0);
  } finally {
    expect(await updateStore(page, data.records, data.links, true)).toBe(200);
  }
});
