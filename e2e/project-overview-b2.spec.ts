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
  // B1: a project is a page of its own (main view), not an inspector over the list.
  await expect(page.locator(".projectPage")).toBeVisible();
  await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
}

// Back to the list of projects (the former "Zavřít" of the inspector).
async function backToProjects(page: Page) {
  await page.locator(".projectBack").click();
  await expect(page.locator(".projectPage")).toHaveCount(0);
}

// The collapsed "Podrobnosti" section: deadline, risks, next step, last activity.
async function openDetails(page: Page) {
  const details = page.locator(".projectDetails");
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await details.locator("summary").click();
  return details;
}

const doneWhen = (page: Page) => page.locator(".projectContext").getByRole("textbox", { name: "Hotovo, když" });

test.describe("B2 project overview", () => {
  test("desktop goal is editable, saved to the canonical store, and survives reopening", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const details = await openDetails(page);
    await expect(details.getByText("Další krok")).toBeVisible();
    await expect(details.getByText("Poslední aktivita")).toBeVisible();
    await expect(details.getByText("Rizika projektu")).toBeVisible();
    await expect(details.getByText("bez dalšího kroku")).toBeVisible();
    const goal = doneWhen(page);
    const text = "Hotový pilot s ověřeným předáním zákazníkovi";
    await goal.fill(text);
    await goal.press("Tab");
    // The text is the context's "Hotovo, když"; the former `goal` mirrors it for one version.
    await expectOnServer(page, (entity) => entity.title === name && (entity.properties?.context as { doneWhen?: string } | undefined)?.doneWhen === text && entity.properties?.goal === text, true);
    await backToProjects(page);
    await openProject(page, name);
    await expect(doneWhen(page)).toHaveValue(text);
  });

  test("All Work explains goal-only read-only restriction without disabling other project actions", async ({ page }) => {
    const name = await createProject(page);
    await page.locator("aside .workspaceButton").click();
    await page.locator('aside .workspaceMenu button[data-workspace-id="all"]').click();
    await expect(page.locator(".appShell")).toHaveAttribute("data-workspace-tone", "all");

    await openProject(page, name);
    const context = page.locator(".projectContext");
    const goal = doneWhen(page);
    await expect(goal).not.toBeEditable();
    await expect(context.getByRole("textbox", { name: "Proč je důležitý" })).not.toBeEditable();
    await expect(context.locator(".projectContextHint"))
      .toContainText("Kontext projektu lze upravit jen v konkrétním prostoru");
    await expect(context.locator(".projectContextHint"))
      .not.toContainText("Veškerá práce je pouze ke čtení");
    // Existing project actions remain usable in All; the hint must not claim otherwise.
    await expect(page.locator(".projectActions").getByRole("button", { name: "Dokončit" })).toBeEnabled();

    await backToProjects(page);
    await page.locator("aside .workspaceButton").click();
    await page.locator('aside .workspaceMenu button[data-workspace-id="personal"]').click();
    await expect(page.locator(".appShell")).toHaveAttribute("data-workspace-tone", "personal");
    await openProject(page, name);
    const editableGoal = doneWhen(page);
    await expect(editableGoal).toBeEditable();
    const text = "Výsledek změněný ve vlastním prostoru";
    await editableGoal.fill(text);
    await editableGoal.press("Tab");
    await expectOnServer(page, (entity) => entity.title === name && (entity.properties?.context as { doneWhen?: string } | undefined)?.doneWhen === text, true);
  });

  test("deadline risk explains its factual source; completing project updates state", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const details = await openDetails(page);
    await details.getByLabel("Termín projektu").fill("2000-01-01");
    await expect(details.locator(".projectOverview")).toContainText("Termín projektu uplynul");
    await expectOnServer(page, (entity) => entity.title === name && entity.properties?.deadline === "2000-01-01", true);
    await page.locator(".projectActions").getByRole("button", { name: "Dokončit" }).click();
    await expect(page.getByTestId("project-status")).toHaveText("Dokončený");
    await expect(page.locator(".projectDetails .projectOverview")).not.toContainText("Termín projektu uplynul");
    await expect.poll(async () => (await serverEntities(page)).some((entity) => entity.title === name && entity.status === "completed"),
      { timeout: 20_000 }).toBe(true);
  });

  test("phone: the project page is the main view, full width, and Back returns to the list", async ({ page }) => {
    const name = await createProject(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page, name);
    await expect(doneWhen(page)).toBeVisible();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const back = await page.locator(".projectBack").boundingBox();
    expect(back).not.toBeNull();
    expect(back!.height).toBeGreaterThanOrEqual(44);
    await page.locator(".projectBack").click();
    await expect(page.locator(".projectPage")).toHaveCount(0);
    await expect(page.locator(".taskRow", { hasText: name }).first()).toBeVisible();
  });
  test("a delayed older goal save cannot erase a newer focused draft", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const goal = doneWhen(page);
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
      await expectOnServer(page, (entity) => entity.title === name && (entity.properties?.context as { doneWhen?: string } | undefined)?.doneWhen === first, true);
      // The first save has now finished and refreshed the project; no saving indicator is left behind.
      await expect(page.getByText("Ukládání…")).toHaveCount(0);
      await expect(goal).toHaveValue(newer);
      await goal.press("Tab");
      await expectOnServer(page, (entity) => entity.title === name && (entity.properties?.context as { doneWhen?: string } | undefined)?.doneWhen === newer, true);
      await expect(goal).toHaveValue(newer);
      await backToProjects(page);
      await openProject(page, name);
      await expect(doneWhen(page)).toHaveValue(newer);
    } finally {
      unblock?.();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("concurrent goal blurs are serialized so the latest one wins", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const goal = doneWhen(page);
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
        entity.title === name && (entity.properties?.context as { doneWhen?: string } | undefined)?.doneWhen === "Druhý cíl má přednost", true);
      await expect(goal).toHaveValue("Druhý cíl má přednost");
      await expect(page.getByText("Ukládání…")).toHaveCount(0);
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
    const projectPicker = page.locator(".fields > label", { hasText: "Projekt" }).locator("select");
    await expect(projectPicker).toHaveCount(1);
    await projectPicker.selectOption({ label: name });
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
    const details = await openDetails(page);
    await expect(details.getByText("bez dalšího kroku")).toBeVisible();
    await expect(details.locator(".projectNextAction")).toHaveCount(0);
  });


  test("a future-scheduled project task is not chosen ahead of an available next action", async ({ page }) => {
    const name = await createProject(page);
    await openProject(page, name);
    const futureTask = "B2 future task " + Date.now();
    const availableTask = "B2 available task " + Date.now();

    async function addProjectTask(title: string) {
      await page.locator(".projectPage").getByRole("button", { name: /Přidat úkol/ }).click();
      const modal = page.locator(".captureModal");
      await expect(modal).toBeVisible();
      await modal.locator("input[aria-label]").first().fill(title);
      await modal.locator("button[type='submit']").click();
      await expect(modal).toHaveCount(0);
    }

    // The earlier project task is deferred far into the future.
    await addProjectTask(futureTask);
    await expectOnServer(page, (entity) => entity.title === futureTask && entity.properties?.inbox !== true, true);
    await page.locator(".projectPage .taskRow", { hasText: futureTask }).click();
    const when = page.locator(".scheduleField input[type='date']");
    await expect(when).toHaveCount(1);
    await when.fill("2099-01-01");
    await expectOnServer(page, (entity) => entity.title === futureTask && entity.properties?.when === "2099-01-01", true);
    // The inspector is for the task only; the project page stays where it is.
    await page.getByRole("button", { name: "Zavřít", exact: true }).click();
    await expect(page.locator(".projectPage")).toBeVisible();
    const details = await openDetails(page);
    await expect(details.getByText("bez dalšího kroku")).toBeVisible();

    // Explicit "dnes" in Quick Capture wins over optional AI-suggested scheduling.
    await addProjectTask(availableTask + " dnes");
    await expectOnServer(page, (entity) => entity.title === availableTask && entity.properties?.inbox !== true, true);
    await expect(details.locator(".projectNextAction")).toHaveText(availableTask);
  });

});
