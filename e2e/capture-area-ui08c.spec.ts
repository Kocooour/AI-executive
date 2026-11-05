import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";

test.describe("UI-08c Quick Capture destination Area", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("project capture shows its real inherited Area, never an unrelated default", async ({ page }) => {
    await page.goto("/?view=Projects");
    await waitUntilSynced(page);
    const fixture = await page.evaluate(async () => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then(r => r.json());
      const tag = `ui08c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const stamp = Date.now();
      const project = { id: `project:${tag}`, title: `Projekt ${tag}`, type: "project", workspaceId: "personal",
        status: "active", properties: {}, createdAt: stamp, updatedAt: stamp };
      const area = { id: `area:${tag}`, title: `Rodina ${tag}`, type: "area", workspaceId: "personal",
        status: "active", properties: {}, createdAt: stamp, updatedAt: stamp };
      const relation = { id: `relation:${tag}`, sourceEntityId: project.id, targetEntityId: area.id,
        relationType: "belongs_to_area", workspaceId: "personal", createdAt: stamp };
      const res = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities, project, area], relations: [...snapshot.relations, relation],
        deletedIds: [], revivedIds: [],
      }) });
      if (!res.ok) throw new Error(`Cannot seed project Area: ${res.status}`);
      return { projectId: project.id, projectTitle: project.title, areaId: area.id, areaTitle: area.title };
    });
    try {
      await page.reload();
      await waitUntilSynced(page);
      await page.locator(".taskRow", { hasText: fixture.projectTitle })
        .getByRole("button", { name: fixture.projectTitle, exact: true }).click();
      const pageProject = page.locator(".projectPage");
      await expect(pageProject).toBeVisible();
      await pageProject.locator(".projectAdd").first().click();
      const dialog = page.getByRole("dialog", { name: "Rychlé zadání" });
      const destination = dialog.getByTestId("capture-destination");
      await expect(destination).toContainText(fixture.projectTitle);
      await expect(destination).toContainText(`Oblast: ${fixture.areaTitle} (z projektu)`);
      await expect(destination).not.toContainText("Nezařazeno");
      await expect(dialog.getByTestId("capture-area-inherited")).toBeVisible();
    } finally {
      const code = await page.evaluate(async ({ projectId, areaId }) => {
        const snapshot = await fetch("/api/store", { cache: "no-store" }).then(r => r.json());
        const ids = [projectId, areaId];
        const res = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
            entities: snapshot.entities.filter((x: { id: string }) => !ids.includes(x.id)),
            relations: snapshot.relations.filter((x: { sourceEntityId: string; targetEntityId: string }) =>
              !ids.includes(x.sourceEntityId) && !ids.includes(x.targetEntityId)),
            deletedIds: ids, revivedIds: [],
          }),
        });
        return res.status;
      }, fixture);
      expect(code).toBe(200);
    }
  });

  test("new AI-suggested project is shown before saving and updates with its edited name", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    await page.route("**/api/task-suggestions", route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ suggestion: {
        projectId: "", projectTitle: "", areaId: "", areaTitle: "",
        priority: "none", estimatedMinutes: 0, scheduledStart: "", scheduledEnd: "",
        scheduledDate: "", scheduledOptions: [], confidence: "medium",
        reasons: [], constraints: [], newProjectSuggestion: {
          title: "Nový projekt Lumi", areaId: "", areaTitle: "", confidence: "medium", reason: "Zachytit úkol",
        },
      } }),
    }));
    await page.locator(".mobileCaptureButton").click();
    const modal = page.getByRole("dialog", { name: "Rychlé zadání" });
    await modal.getByRole("textbox", { name: "Název úkolu" }).fill("Zařídit materiál pro projekt");
    const proposal = modal.getByRole("radio", { name: /Vytvořit nový projekt a přiřadit/ });
    await expect(proposal).toBeVisible();
    await proposal.check();
    const destination = modal.getByTestId("capture-destination");
    await expect(destination).toContainText("Projekt: Nový projekt Lumi");
    await expect(destination).toContainText("Oblast: Nezařazeno");
    await modal.getByRole("textbox", { name: "Název nového projektu" }).fill("Nový projekt – upravený");
    await expect(destination).toContainText("Projekt: Nový projekt – upravený");
    await expect(destination).not.toContainText("Projekt: Nový projekt Lumi");
    // Draft is not submitted. It must remain a preview, never a silently created project.
  });
});
