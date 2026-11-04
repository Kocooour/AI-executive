import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";
import type { Page } from "@playwright/test";

// UI-05a intentionally uses the existing legacy project store. This visual
// preview must not imply that target R3 project ACL is active.
const stamp = () => Date.now().toString(36);
const entity = (id: string, type: string, title: string, status: string, properties: Record<string, unknown> = {}) => {
  const now = Date.now();
  return { id, type, title, status, workspaceId: "personal", properties, createdAt: now, updatedAt: now };
};
async function seedPreview(page: Page, ids: Record<string, string>) {
  const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  const entities = [
    entity(ids.area, "area", "Rodina", "active", { kind: "private" }),
    entity(ids.overdue, "project", "Naplánovat rodinnou akci s velmi dlouhým názvem pro mobil", "active"),
    entity(ids.finished, "project", "Hotový rodinný projekt", "completed"),
    entity(ids.empty, "project", "Projekt bez kroků", "active"),
    entity(ids.task, "task", "Otevřený úkol po termínu", "open", { deadline: past }),
  ];
  const now = Date.now();
  const relations = [
    ...[ids.overdue, ids.finished, ids.empty].map((projectId, i) => ({
      id: `ui05a-area-${i}-${now}`, sourceEntityId: projectId, targetEntityId: ids.area,
      relationType: "belongs_to_area", workspaceId: "personal", createdAt: now,
    })),
    { id: `ui05a-task-${now}`, sourceEntityId: ids.task, targetEntityId: ids.overdue,
      relationType: "belongs_to_project", workspaceId: "personal", createdAt: now },
  ];
  await expect.poll(() => page.evaluate(async ({ entities, relations }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((res) => res.json());
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities, ...entities], relations: [...snapshot.relations, ...relations],
        deletedIds: [], revivedIds: [] }) });
    return response.status;
  }, { entities, relations }), { timeout: 15_000 }).toBe(200);
}
async function cleanPreview(page: Page, ids: Record<string, string>) {
  await expect.poll(() => page.evaluate(async (gone) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((res) => res.json());
    const remove = new Set(gone);
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: snapshot.entities.filter((row: { id: string }) => !remove.has(row.id)),
        relations: snapshot.relations.filter((r: { sourceEntityId: string; targetEntityId: string }) =>
          !remove.has(r.sourceEntityId) && !remove.has(r.targetEntityId)),
        deletedIds: gone, revivedIds: [] }) });
    return response.status;
  }, Object.values(ids)), { timeout: 15_000 }).toBe(200);
}

test("phone project list has accessible pastel Areas, one issue, circular statuses and safe completion", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview disabled");
  const id = stamp();
  const ids = { area: `ui05a-area-${id}`, overdue: `ui05a-overdue-${id}`,
    finished: `ui05a-finished-${id}`, empty: `ui05a-empty-${id}`, task: `ui05a-task-${id}` };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await seedPreview(page, ids);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const list = page.locator('.projectGroups[data-projects-preview="lumi-v1"]');
    await expect(list).toBeVisible();
    const group = page.locator(`[data-project-group="${ids.area}"]`);
    await expect(group).toHaveAttribute("data-preview-area-tone", "family");
    await expect(group).toHaveAttribute("aria-labelledby", `project-group-area:${ids.area}`);
    await expect(group.locator("h2.projectGroupHeading")).toHaveText("Rodina");
    await expect(group.locator("h2.projectGroupHeading")).toHaveCSS("clip-path", "inset(50%)");
    const urgent = group.locator(`[data-project-preview-row="${ids.overdue}"]`);
    await expect(urgent).toHaveAttribute("data-project-tone", "danger");
    await expect(urgent.locator("[data-project-summary]")).toHaveText("Po termínu");
    await expect(urgent.locator(".projectRowWhy, .projectRowNext, .taskRowMeta")).toHaveCount(0);
    await expect(urgent.locator(".v1ProjectCircle")).toHaveText("");
    await expect(urgent.locator(".v1ProjectCircle")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(urgent.locator(".v1ProjectCircle")).toHaveCSS("border-top-color", "rgb(239, 68, 68)");
    await expect(urgent.locator(".v1ProjectName")).toHaveCSS("font-weight", "650");
    const completed = group.locator(`[data-project-preview-row="${ids.finished}"]`);
    await expect(completed).toHaveAttribute("data-project-tone", "complete");
    await expect(completed.locator(".v1ProjectCircle")).toHaveText("✓");
    await expect(completed.locator("[data-project-summary]")).toHaveCount(0);
    const empty = group.locator(`[data-project-preview-row="${ids.empty}"]`);
    await expect(empty).toHaveAttribute("data-project-tone", "warning");
    await expect(empty.locator("[data-project-summary]")).toHaveText("Chybí další krok");
    await expect(empty.locator(".v1ProjectCircle")).toHaveCSS("border-top-color", "rgb(245, 158, 11)");
    const circle = urgent.locator(`[data-project-status-control="${ids.overdue}"]`);
    expect((await circle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const drag = urgent.locator(".dragHandle");
    expect((await drag.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect((await drag.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await circle.click();
    const confirm = page.locator("dialog.confirmDialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("1 nedokončený úkol");
    await expect(confirm).toContainText("stav podřízených úkolů nezmění");
    await confirm.getByRole("button", { name: "Zrušit" }).click();
    await expect(urgent).toHaveAttribute("data-project-tone", "danger");
    await circle.click();
    await confirm.getByRole("button", { name: "Dokončit", exact: true }).click();
    await expect(urgent).toHaveAttribute("data-project-tone", "complete");
    await expect.poll(async () => page.evaluate(async ({ projectId, taskId }) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
      return [snapshot.entities.find((e: { id: string }) => e.id === projectId)?.status,
        snapshot.entities.find((e: { id: string }) => e.id === taskId)?.status];
    }, { projectId: ids.overdue, taskId: ids.task })).toEqual(["completed", "open"]);
    await urgent.locator(".v1ProjectName .taskRowOpen").click();
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", ids.overdue);
    await page.locator(".projectBack").click();
    await expect(urgent).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // Responsive preview never replaces the original desktop project list.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.projectGroups[data-projects-preview="lumi-v1"]')).toHaveCount(0);
    await expect(group.locator(".projectGroupHeading")).toBeVisible();
    await expect(group.locator(`[data-project-preview-row="${ids.overdue}"]`)).toHaveCount(0);
    await expect(group.locator(".taskRowMeta").first()).toBeVisible();
  } finally {
    await cleanPreview(page, ids);
  }
});
