import { test, expect, type Page } from "./fixtures";
import { seeded, serverEntities, waitUntilSynced } from "./helpers";

test.describe("B1 Inbox triage", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function openNewInboxTask(page: Page) {
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const title = `B1 triage ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const input = page.locator(".capture input");
    await input.fill(title);
    await input.press("Enter");
    const row = page.locator(".taskRow", { hasText: title }).first();
    await expect(row).toBeVisible();
    const task = await expect.poll(async () =>
      (await serverEntities(page)).find((entity) => entity.title === title && entity.type === "task")?.properties?.inbox,
      { timeout: 20_000 }).toBe(true);
    void task;
    await row.click();
    await expect(page.locator(".inboxTriage")).toBeVisible();
    return title;
  }

  test("Today removes the task from Inbox and preserves its original input", async ({ page }) => {
    const title = await openNewInboxTask(page);
    const triage = page.locator(".inboxTriage");
    await expect(triage).toContainText(title);
    await triage.getByRole("button", { name: "Dnes", exact: true }).click();
    await expect.poll(async () => {
      const task = (await serverEntities(page)).find((entity) => entity.title === title);
      return { inbox: task?.properties?.inbox, today: task?.properties?.today };
    }, { timeout: 20_000 }).toEqual({ inbox: false, today: true });
    await expect(page.locator(".inboxTriage")).toHaveCount(0);
  });

  test("project triage moves the task atomically, with its workspace preserved", async ({ page }) => {
    const title = await openNewInboxTask(page);
    const projectField = page.locator(".inboxTriage label", { hasText: "Do projektu" });
    await projectField.locator("select").selectOption({ label: seeded.project });
    await projectField.getByRole("button", { name: "Použít" }).click();
    await expect.poll(async () => page.evaluate(async (taskTitle) => {
      const response = await fetch("/api/store", { cache: "no-store" });
      const snapshot = await response.json();
      const task = snapshot.entities.find((entity: { title: string }) => entity.title === taskTitle);
      const project = snapshot.entities.find((entity: { title: string; type: string }) => entity.type === "project" && entity.title === "Projekt Alfa");
      return {
        inbox: task?.properties?.inbox,
        linked: Boolean(task && project && snapshot.relations.some((relation: {
          sourceEntityId: string; targetEntityId: string; workspaceId: string; relationType: string;
        }) => relation.sourceEntityId === task.id && relation.targetEntityId === project.id &&
          relation.workspaceId === task.workspaceId && relation.relationType === "belongs_to_project")),
      };
    }, title), { timeout: 20_000 }).toEqual({ inbox: false, linked: true });
  });

  test("waiting leaves Inbox and exposes follow-up controls", async ({ page }) => {
    const title = await openNewInboxTask(page);
    await page.locator(".inboxTriage").getByRole("button", { name: "Čeká na" }).click();
    await expect.poll(async () => {
      const task = (await serverEntities(page)).find((entity) => entity.title === title);
      return { inbox: task?.properties?.inbox, waiting: task?.properties?.waiting };
    }, { timeout: 20_000 }).toEqual({ inbox: false, waiting: true });
    await expect(page.locator(".waitingField input[type=checkbox]")).toBeChecked();
  });

  test("All my work does not offer triage writes", async ({ page }) => {
    await openNewInboxTask(page);
    await page.locator(".detail .close").click();
    await page.locator(".mobileWorkspaceButton").click();
    await page.locator('.mobileWorkspaceMenu [data-workspace-id="all"]').click();
    await page.locator(".taskRow").first().click();
    const triage = page.locator(".inboxTriage");
    await expect(triage).toBeVisible();
    await expect(triage).toContainText("pouze ke čtení");
    await expect(triage.getByRole("button", { name: "Dnes", exact: true })).toBeDisabled();
    await expect(triage.getByRole("button", { name: "Zahodit" })).toBeDisabled();
  });

  test("discard requires confirmation; cancelling preserves the task", async ({ page }) => {
    const title = await openNewInboxTask(page);
    await page.locator(".inboxTriage").getByRole("button", { name: "Zahodit" }).click();
    const dialog = page.locator("dialog.confirmDialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Zrušit" }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await serverEntities(page)).some((entity) => entity.title === title)).toBe(true);
  });
});
