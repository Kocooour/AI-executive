import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { expectOnServer, serverEntities, waitUntilSynced } from "./helpers";

async function createProject(page: Page) {
  // Creation through the UI also verifies the project can be reopened from the list.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const name = `B2 project overview ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const capture = page.locator(".capture input");
  await expect(capture).toBeVisible();
  await capture.fill(name);
  await capture.press("Enter");
  const row = page.locator(".taskRow", { hasText: name }).first();
  await expect(row).toBeVisible();
  await expectOnServer(page, (entity) => entity.title === name && entity.id.length > 0, true);
  return name;
}

async function openProject(page: Page, name: string) {
  const row = page.locator(".taskRow", { hasText: name }).first();
  await row.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".projectOverview")).toBeVisible();
}

test.describe("B2 project overview", () => {
  test("desktop goal is editable, saved to the canonical store, and survives reopening", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const overview = page.locator(".projectOverview");
    await expect(overview.getByText("Cíl / výsledek")).toBeVisible();
    await expect(overview.getByText("Další akce")).toBeVisible();
    await expect(overview.getByText("Poslední aktivita")).toBeVisible();
    await expect(overview.getByText("Rizika projektu")).toBeVisible();
    await expect(overview.getByText("Není určená")).toBeVisible();
    const goal = overview.getByRole("textbox", { name: "Cíl / výsledek" });
    const text = "Hotový pilot s ověřeným předáním zákazníkovi";
    await goal.fill(text);
    await goal.press("Tab");
    await expectOnServer(page, (entity) => entity.title === name && entity.properties?.goal === text, true);
    await page.getByRole("button", { name: "Zavřít", exact: true }).click();
    await openProject(page, name);
    await expect(page.locator(".projectOverview").getByRole("textbox", { name: "Cíl / výsledek" })).toHaveValue(text);
  });

  test("deadline risk explains its factual source; completing project updates state", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    await page.locator(".projectDetail > label input[type='date']").fill("2000-01-01");
    await expect(page.locator(".projectOverview")).toContainText("Termín projektu uplynul");
    await expectOnServer(page, (entity) => entity.title === name && entity.properties?.deadline === "2000-01-01", true);
    await page.locator(".projectActions").getByRole("button", { name: "Dokončit" }).click();
    await expect(page.getByTestId("project-overview-status")).toHaveText("Dokončený");
    await expect(page.locator(".projectOverview")).not.toContainText("Termín projektu uplynul");
    await expect.poll(async () => (await serverEntities(page)).some((entity) => entity.title === name && entity.status === "completed"),
      { timeout: 20_000 }).toBe(true);
  });

  test("mobile inspector shows the same project overview in a full-screen sheet", async ({ page }) => {
    const name = await createProject(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page, name);
    const inspector = page.locator("aside.inspectorDetail");
    await expect(inspector).toBeVisible();
    await expect(page.getByRole("button", { name: "← Zpět" })).toBeVisible();
    await expect(page.locator(".projectOverview").getByRole("textbox", { name: "Cíl / výsledek" })).toBeVisible();
    const rect = await inspector.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.width).toBeGreaterThanOrEqual(389);
    await page.getByRole("button", { name: "← Zpět" }).click();
    await expect(inspector).toHaveCount(0);
  });
  test("a delayed older goal save cannot erase a newer focused draft", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const goal = page.locator(".projectOverview").getByRole("textbox", { name: "Cíl / výsledek" });
    const first = "První výsledek — čeká na síť";
    const newer = "Nově rozepsaný výsledek zůstane zachován";
    let unblock: (() => void) | undefined;
    let signalBlocked: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { signalBlocked = resolve; });
    let firstPut = true;
    await page.route("**/api/store", async (route) => {
      if (route.request().method() !== "PUT" || !firstPut) return route.continue();
      firstPut = false;
      await new Promise<void>((resolve) => { unblock = resolve; signalBlocked(); });
      await route.continue();
    });
    try {
      await goal.fill(first);
      await goal.press("Tab");
      await blocked;
      await goal.focus();
      await goal.fill(newer);
      unblock?.();
      await expectOnServer(page, (entity) => entity.title === name && entity.properties?.goal === first, true);
      // The first save has now finished and refreshed the selected project.
      await expect(page.locator(".projectOverview [role='status']")).toHaveCount(0);
      await expect(goal).toHaveValue(newer);
      await goal.press("Tab");
      await expectOnServer(page, (entity) => entity.title === name && entity.properties?.goal === newer, true);
      await expect(goal).toHaveValue(newer);
      await page.getByRole("button", { name: "Zavřít", exact: true }).click();
      await openProject(page, name);
      await expect(page.locator(".projectOverview").getByRole("textbox", { name: "Cíl / výsledek" }))
        .toHaveValue(newer);
    } finally {
      unblock?.();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("concurrent goal blurs are serialized so the latest one wins", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const goal = page.locator(".projectOverview").getByRole("textbox", { name: "Cíl / výsledek" });
    let unblock: (() => void) | undefined;
    let signalBlocked: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { signalBlocked = resolve; });
    let firstPut = true;
    await page.route("**/api/store", async (route) => {
      if (route.request().method() !== "PUT" || !firstPut) return route.continue();
      firstPut = false;
      await new Promise<void>((resolve) => { unblock = resolve; signalBlocked(); });
      await route.continue();
    });
    try {
      await goal.fill("První cíl");
      await goal.press("Tab");
      await blocked;
      await goal.focus();
      await goal.fill("Druhý cíl má přednost");
      await goal.press("Tab");
      unblock?.();
      await expectOnServer(page, (entity) =>
        entity.title === name && entity.properties?.goal === "Druhý cíl má přednost", true);
      await expect(goal).toHaveValue("Druhý cíl má přednost");
      await expect(page.locator(".projectOverview [role='status']")).toHaveCount(0);
    } finally {
      unblock?.();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("an Inbox item linked to a project is not yet its next actionable task", async ({ page }) => {
    const name = await createProject(page);
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const taskName = "B2 untriaged project task " + Date.now();
    const input = page.locator(".capture input");
    await expect(input).toBeVisible();
    await input.fill(taskName);
    await input.press("Enter");
    const taskRow = page.locator(".taskRow", { hasText: taskName }).first();
    await expect(taskRow).toBeVisible();
    await taskRow.click();
    // This is the ordinary relation picker, not the Inbox triage action.
    await page.locator(".detail label", { hasText: "Projekt" }).locator("select")
      .selectOption({ label: name });
    await expect.poll(async () => page.evaluate(async ({ taskTitle, projectTitle }) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const task = snapshot.entities.find((entity: { title: string }) => entity.title === taskTitle);
      const project = snapshot.entities.find((entity: { title: string }) => entity.title === projectTitle);
      return Boolean(task?.properties?.inbox === true && project &&
        snapshot.relations.some((relation: { sourceEntityId: string; targetEntityId: string; relationType: string }) =>
          relation.sourceEntityId === task.id && relation.targetEntityId === project.id &&
          relation.relationType === "belongs_to_project"));
    }, { taskTitle: taskName, projectTitle: name })).toBe(true);
    await page.getByRole("button", { name: "Zavřít", exact: true }).click();
    await page.goto("/?view=Projects");
    await waitUntilSynced(page);
    await openProject(page, name);
    await expect(page.locator(".projectOverview").getByText("Není určená")).toBeVisible();
    await expect(page.locator(".projectOverview .projectNextAction")).toHaveCount(0);
  });

});
