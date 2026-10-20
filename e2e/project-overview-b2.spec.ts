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
    await expect(overview.getByText("Signály rizika")).toBeVisible();
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
});
