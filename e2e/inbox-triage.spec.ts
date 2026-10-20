import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { serverEntities, waitUntilSynced } from "./helpers";

test.describe("B1 Inbox triage", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function createActiveProject(page: Page) {
    // The E2E instance is intentionally shared by the entire suite. Earlier scenarios
    // may have completed or deleted seeded projects: each triage test owns its target.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=Projects");
    await waitUntilSynced(page);
    const name = "B1 active project " + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const entry = page.locator(".capture input");
    await expect(entry).toBeVisible();
    await entry.fill(name);
    await entry.press("Enter");
    await expect(page.locator(".taskRow", { hasText: name })).toBeVisible();
    await expect.poll(async () => {
      const projects = await serverEntities(page);
      return projects.find((project) => project.type === "project" && project.title === name)?.status;
    }, { timeout: 20_000 }).toBe("active");
    await page.setViewportSize({ width: 390, height: 844 });
    return name;
  }

  async function openNewInboxTask(page: Page) {
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const title = `B1 triage ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const input = page.locator(".capture input");
    if (await input.isVisible()) {
      await input.fill(title);
      await input.press("Enter");
    } else {
      await page.getByRole("button", { name: "Rychlé zadání" }).click();
      const capture = page.getByRole("dialog", { name: "Rychlé zadání" });
      await expect(capture).toBeVisible();
      await capture.getByRole("textbox", { name: "Název úkolu" }).fill(title);
      await expect(capture.locator(".captureSuggestion, .captureSuggestionState.error"))
        .toBeVisible({ timeout: 10_000 });
      // Keep this Inbox fixture unassigned even when adaptive suggestions find a project.
      const useSuggestion = capture.getByRole("checkbox", { name: "Použít návrh Lumi" });
      if (await useSuggestion.isVisible()) await useSuggestion.uncheck();
      await capture.getByRole("button", { name: "Přidat úkol" }).click();
      await expect(capture).not.toBeVisible();
    }
    const row = page.locator(".taskRow", { hasText: title }).first();
    await expect(row).toBeVisible();
    await expect.poll(async () =>
      (await serverEntities(page)).find((entity) => entity.title === title && entity.type === "task")?.properties?.inbox,
      { timeout: 20_000 }).toBe(true);
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
    const projectName = await createActiveProject(page);
    const title = await openNewInboxTask(page);
    const projectField = page.locator(".inboxTriage label", { hasText: "Do projektu" });
    await projectField.locator("select").selectOption({ label: projectName });
    await projectField.getByRole("button", { name: "Použít" }).click();
    await expect.poll(async () => page.evaluate(async ({ taskTitle, targetTitle }) => {
      const response = await fetch("/api/store", { cache: "no-store" });
      const snapshot = await response.json();
      const task = snapshot.entities.find((entity: { title: string }) => entity.title === taskTitle);
      const project = snapshot.entities.find((entity: { title: string; type: string }) => entity.type === "project" && entity.title === targetTitle);
      return {
        inbox: task?.properties?.inbox,
        linked: Boolean(task && project && snapshot.relations.some((relation: {
          sourceEntityId: string; targetEntityId: string; workspaceId: string; relationType: string;
        }) => relation.sourceEntityId === task.id && relation.targetEntityId === project.id &&
          relation.workspaceId === task.workspaceId && relation.relationType === "belongs_to_project")),
      };
    }, { taskTitle: title, targetTitle: projectName }), { timeout: 20_000 }).toEqual({ inbox: false, linked: true });
  });

  test("two tabs triaging one task cannot create duplicate project memberships", async ({ page }) => {
    const projectName = await createActiveProject(page);
    const title = await openNewInboxTask(page);
    const second = await page.context().newPage();
    try {
      await second.goto("/?view=Inbox");
      await waitUntilSynced(second);
      await second.locator(".taskRow", { hasText: title }).first().click();
      const firstField = page.locator(".inboxTriage label", { hasText: "Do projektu" });
      const secondField = second.locator(".inboxTriage label", { hasText: "Do projektu" });
      await firstField.locator("select").selectOption({ label: projectName });
      await secondField.locator("select").selectOption({ label: projectName });

      // Dispatch in two tabs without awaiting either async handler. Both previously
      // read an empty membership outside the transaction and inserted separate links.
      await Promise.all([
        firstField.getByRole("button", { name: "Použít" }).evaluate((button) => (button as HTMLButtonElement).click()),
        secondField.getByRole("button", { name: "Použít" }).evaluate((button) => (button as HTMLButtonElement).click()),
      ]);
      // Only the first triage can commit; the other tab may retain an error until
      // it refreshes its stale inspector.
      const taskId = (await serverEntities(page)).find((entity) => entity.title === title)?.id;
      expect(taskId).toBeTruthy();
      // Inspect IndexedDB directly, not only the server: the race occurs in the
      // tabs' shared local database, before either sync request completes.
      await expect.poll(() => page.evaluate((id) => new Promise<{ count: number; inbox: boolean | undefined }>((resolve, reject) => {
        const opened = indexedDB.open("ai-executive");
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const tx = db.transaction(["entities", "relations"], "readonly");
          const task = tx.objectStore("entities").get(id);
          const links = tx.objectStore("relations").index("sourceEntityId").getAll(id);
          tx.oncomplete = () => {
            resolve({
              count: links.result.filter((relation: { relationType: string }) =>
                relation.relationType === "belongs_to_project").length,
              inbox: task.result?.properties?.inbox,
            });
            db.close();
          };
          tx.onerror = () => { reject(tx.error); db.close(); };
        };
      }), taskId!), { timeout: 20_000 }).toEqual({ count: 1, inbox: false });

      await expect.poll(async () => page.evaluate(async (taskTitle) => {
        const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
        const task = snapshot.entities.find((entity: { type: string; title: string }) =>
          entity.type === "task" && entity.title === taskTitle);
        return {
          count: snapshot.relations.filter((relation: { sourceEntityId: string; relationType: string }) =>
            relation.sourceEntityId === task?.id && relation.relationType === "belongs_to_project").length,
          inbox: task?.properties?.inbox,
        };
      }, title), { timeout: 20_000 }).toEqual({ count: 1, inbox: false });
    } finally {
      await second.close();
    }
  });

  test("a stale tab cannot replace a project's already completed Inbox triage", async ({ page }) => {
    const firstProject = await createActiveProject(page);
    const competingProject = await createActiveProject(page);

    const title = await openNewInboxTask(page);
    const second = await page.context().newPage();
    try {
      await second.goto("/?view=Inbox");
      await waitUntilSynced(second);
      await second.locator(".taskRow", { hasText: title }).first().click();
      const firstField = page.locator(".inboxTriage label", { hasText: "Do projektu" });
      const secondField = second.locator(".inboxTriage label", { hasText: "Do projektu" });
      await firstField.locator("select").selectOption({ label: firstProject });
      await secondField.locator("select").selectOption({ label: competingProject });

      // The first decision commits; the other tab has already selected a different
      // target. If that stale control remains usable, its write must be rejected.
      await firstField.getByRole("button", { name: "Použít" }).click();
      const membership = async () => page.evaluate(async ({ taskTitle, expectedProject }) => {
        const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
        const task = snapshot.entities.find((entity: { type: string; title: string }) =>
          entity.type === "task" && entity.title === taskTitle);
        return {
          inbox: task?.properties?.inbox,
          targets: snapshot.relations.filter((relation: { sourceEntityId: string; relationType: string }) =>
            relation.sourceEntityId === task?.id && relation.relationType === "belongs_to_project")
            .map((relation: { targetEntityId: string }) => relation.targetEntityId),
          expected: snapshot.entities.find((entity: { type: string; title: string }) =>
            entity.type === "project" && entity.title === expectedProject)?.id,
        };
      }, { taskTitle: title, expectedProject: firstProject });
      await expect.poll(async () => {
        const state = await membership();
        return { inbox: state.inbox, assigned: state.targets.length === 1 && state.targets[0] === state.expected };
      }, { timeout: 20_000 }).toEqual({ inbox: false, assigned: true });

      const competingAction = secondField.getByRole("button", { name: "Použít" });
      if (await competingAction.isVisible() && await competingAction.isEnabled()) {
        await competingAction.click();
        // It may show the stale-triage error, or disappear when another tab's
        // persisted state refreshes the inspector.
        await expect.poll(async () =>
          (await second.getByRole("alert").count()) > 0 ||
          (await second.locator(".inboxTriage").count()) === 0,
        { timeout: 20_000 }).toBe(true);
      }
      await waitUntilSynced(second);
      await expect.poll(async () => {
        const state = await membership();
        return { inbox: state.inbox, assigned: state.targets.length === 1 && state.targets[0] === state.expected };
      }, { timeout: 20_000 }).toEqual({ inbox: false, assigned: true });
    } finally {
      await second.close();
    }
  });

  test("concurrent Today and Waiting decisions commit only one outcome", async ({ page }) => {
    const title = await openNewInboxTask(page);
    const second = await page.context().newPage();
    try {
      await second.goto("/?view=Inbox");
      await waitUntilSynced(second);
      await second.locator(".taskRow", { hasText: title }).first().click();
      await Promise.all([
        page.locator(".inboxTriage").getByRole("button", { name: "Dnes", exact: true })
          .evaluate((button) => (button as HTMLButtonElement).click()),
        second.locator(".inboxTriage").getByRole("button", { name: "Čeká na" })
          .evaluate((button) => (button as HTMLButtonElement).click()),
      ]);
      await expect.poll(async () => {
        const task = (await serverEntities(page)).find((entity) => entity.title === title);
        return {
          inbox: task?.properties?.inbox,
          decisions: [task?.properties?.today === true, task?.properties?.waiting === true]
            .filter(Boolean).length,
        };
      }, { timeout: 20_000 }).toEqual({ inbox: false, decisions: 1 });
    } finally {
      await second.close();
    }
  });

  test("confirmation from a stale tab cannot discard an already triaged task", async ({ page }) => {
    const title = await openNewInboxTask(page);
    const second = await page.context().newPage();
    try {
      await second.goto("/?view=Inbox");
      await waitUntilSynced(second);
      await second.locator(".taskRow", { hasText: title }).first().click();
      await second.locator(".inboxTriage").getByRole("button", { name: "Zahodit" }).click();
      const dialog = second.locator("dialog.confirmDialog");
      await expect(dialog).toBeVisible();

      await page.locator(".inboxTriage").getByRole("button", { name: "Dnes", exact: true }).click();
      await expect.poll(async () => {
        const task = (await serverEntities(page)).find((entity) => entity.title === title);
        return { inbox: task?.properties?.inbox, today: task?.properties?.today };
      }, { timeout: 20_000 }).toEqual({ inbox: false, today: true });

      await dialog.getByRole("button", { name: "Zahodit" }).click();
      await expect.poll(async () => {
        const task = (await serverEntities(page)).find((entity) => entity.title === title);
        return { exists: Boolean(task), inbox: task?.properties?.inbox, today: task?.properties?.today };
      }, { timeout: 20_000 }).toEqual({ exists: true, inbox: false, today: true });
    } finally {
      await second.close();
    }
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
