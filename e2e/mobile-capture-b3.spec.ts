import { test, expect } from "./fixtures";
import { expectOnServer, waitUntilSynced } from "./helpers";
import type { Page } from "@playwright/test";

// A unique, synthetic legacy workspace for each scenario. The isolated E2E server is
// shared by all browser scenarios within a run, so every fixture must be torn down.
async function seedSharedCaptureWorkspace(page: Page, workspaceId: string, areaId: string) {
  await expect.poll(() => page.evaluate(async ({ workspaceId, areaId }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
    const now = Date.now();
    const entities = [
      { id: `workspace:${workspaceId}`, type: "workspace", title: "B3 druhý prostor",
        status: "active", workspaceId, properties: {
          kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }],
        }, createdAt: now, updatedAt: now },
      // Choosing this explicit Area for new tasks/projects avoids creating a
      // protected system fallback Area that the server correctly forbids deleting.
      { id: areaId, type: "area", title: "B3 testovací oblast",
        status: "active", workspaceId, properties: { kind: "shared" },
        createdAt: now, updatedAt: now },
    ];
    const response = await fetch("/api/store", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities, ...entities], relations: snapshot.relations,
        deletedIds: [], revivedIds: [],
      }),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error(`B3 workspace fixture: ${response.status}`);
    return true;
  }, { workspaceId, areaId }), { timeout: 15_000 }).toBe(true);
}

async function cleanSharedCaptureWorkspace(page: Page, workspaceId: string) {
  // Remove exactly this scenario's workspace and all its contents, including
  // tasks, projects, explicit Areas and every relation referencing them.
  // Never alter the Personal space or another scenario's records.
  await expect.poll(() => page.evaluate(async (workspaceId) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
    const removed = snapshot.entities.filter((entity: { workspaceId: string }) => entity.workspaceId === workspaceId);
    const removedIds = new Set(removed.map((entity: { id: string }) => entity.id));
    const removedRelations = snapshot.relations.filter((relation: {
      workspaceId: string; sourceEntityId: string; targetEntityId: string;
    }) => relation.workspaceId === workspaceId ||
      removedIds.has(relation.sourceEntityId) || removedIds.has(relation.targetEntityId));
    if (!removed.length && !removedRelations.length) return true;
    const removedRelationIds = new Set(removedRelations.map((relation: { id: string }) => relation.id));
    const response = await fetch("/api/store", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: snapshot.entities.filter((entity: { id: string }) => !removedIds.has(entity.id)),
        relations: snapshot.relations.filter((relation: { id: string }) => !removedRelationIds.has(relation.id)),
        deletedIds: [...removedIds, ...removedRelationIds], revivedIds: [],
      }),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error(`B3 workspace cleanup: ${response.status}`);
    return true;
  }, workspaceId), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.evaluate(async (workspaceId) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
    return !snapshot.entities.some((entity: { workspaceId: string }) => entity.workspaceId === workspaceId) &&
      !snapshot.relations.some((relation: { workspaceId: string }) => relation.workspaceId === workspaceId);
  }, workspaceId)).toBe(true);
}

async function withSharedCaptureWorkspace(
  page: Page, run: (fixture: { workspaceId: string; areaId: string }) => Promise<void>,
) {
  const workspaceId = `e2e-b3-workspace-${crypto.randomUUID()}`;
  const areaId = `e2e-b3-area-${crypto.randomUUID()}`;
  try {
    await seedSharedCaptureWorkspace(page, workspaceId, areaId);
    await page.reload();
    await waitUntilSynced(page);
    await run({ workspaceId, areaId });
  } finally {
    // Also when seeding/reloading or the browser assertions fail.
    await cleanSharedCaptureWorkspace(page, workspaceId);
  }
}

test.describe("B3 mobile Quick Capture", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await waitUntilSynced(page);
  });

  test("closing preserves the unsaved task and note independently; discard and reload clear them", async ({ page }) => {
    const open = () => page.locator(".mobileCaptureButton").click();
    const modal = page.locator(".captureModal");
    await open();
    await expect(modal).toBeVisible();
    await modal.getByRole("textbox", { name: "Název úkolu" }).fill("B3 rozepsaný úkol bez uložení");
    await expect(modal.getByText("Koncept zůstává v tomto panelu", { exact: false })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Úkol", exact: true })).toHaveAttribute("aria-pressed", "true");
    await modal.getByRole("button", { name: "Poznámka", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("");
    await modal.getByRole("textbox", { name: "Název poznámky" }).fill("B3 vlastní koncept poznámky");
    await modal.getByRole("button", { name: "Úkol", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("B3 rozepsaný úkol bez uložení");

    await modal.getByRole("button", { name: "Zrušit" }).click();
    await expect(modal).toHaveCount(0);
    await page.locator('.mobileNav button[data-nav-view="Today"]').click();
    await open();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("B3 rozepsaný úkol bez uložení");
    await modal.getByRole("button", { name: "Poznámka", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("B3 vlastní koncept poznámky");
    await modal.getByRole("button", { name: "Zahodit koncept" }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("");
    await modal.getByRole("button", { name: "Úkol", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("B3 rozepsaný úkol bez uložení");
    await modal.getByRole("button", { name: "Zrušit" }).click();

    // This iteration intentionally stores no unfinished private text persistently.
    await page.reload();
    await waitUntilSynced(page);
    await open();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("");
    await modal.getByRole("button", { name: "Poznámka", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("");
  });

  test("a late task sync cannot erase a newer note draft", async ({ page }) => {
    // Keep suggestion timing and project recommendations out of this sync-race test.
    await page.route("**/api/task-suggestions", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    let releaseFirstPut: (() => void) | undefined;
    let firstPutBlocked: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { firstPutBlocked = resolve; });
    let held = false;
    await page.route("**/api/store", async (route) => {
      if (route.request().method() !== "PUT" || held) return route.continue();
      held = true;
      await new Promise<void>((resolve) => { releaseFirstPut = resolve; firstPutBlocked(); });
      await route.continue();
    });
    const title = `B3 first queued task ${Date.now()}`;
    const noteText = "B3 new note survives older sync";
    const modal = page.locator(".captureModal");
    try {
      await page.locator(".mobileCaptureButton").click();
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill(title);
      // Suggestions may be pending, but a direct create is still supported.
      await expect(modal.getByRole("button", { name: "Přidat úkol" })).toBeEnabled();
      await modal.getByRole("button", { name: "Přidat úkol" }).click();
      await blocked;
      await expect(modal).toHaveCount(0);
      await page.locator(".mobileCaptureButton").click();
      await modal.getByRole("button", { name: "Poznámka", exact: true }).click();
      await modal.getByRole("textbox", { name: "Název poznámky" }).fill(noteText);
      releaseFirstPut?.();
      await expectOnServer(page, (entity) => entity.title === title, true);
      // Confirm the previous submit's async continuation ran before testing
      // the new unsaved note's survival after closing/reopening.
      await waitUntilSynced(page);
      await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue(noteText);
      await modal.getByRole("button", { name: "Zrušit" }).click();
      await page.locator(".mobileCaptureButton").click();
      await modal.getByRole("button", { name: "Poznámka", exact: true }).click();
      await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue(noteText);
    } finally {
      releaseFirstPut?.();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("editing the same draft scope during an older save keeps the newer generation", async ({ page }) => {
    // Keep suggestion timing and project recommendations out of this sync-race test.
    await page.route("**/api/task-suggestions", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    let releaseFirstPut: (() => void) | undefined;
    let signal: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { signal = resolve; });
    let intercepted = false;
    await page.route("**/api/store", async (route) => {
      if (route.request().method() !== "PUT" || intercepted) return route.continue();
      intercepted = true;
      await new Promise<void>((resolve) => { releaseFirstPut = resolve; signal(); });
      await route.continue();
    });
    const first = `B3 submitted task ${Date.now()}`;
    const second = "B3 second unsaved task in the same workspace";
    const modal = page.locator(".captureModal");
    try {
      await page.locator(".mobileCaptureButton").click();
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill(first);
      await expect(modal.getByRole("button", { name: "Přidat úkol" })).toBeEnabled();
      await modal.getByRole("button", { name: "Přidat úkol" }).click();
      await blocked;
      await page.locator(".mobileCaptureButton").click();
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill(second);
      releaseFirstPut?.();
      await expectOnServer(page, (entity) => entity.title === first, true);
      await waitUntilSynced(page);
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue(second);
      await modal.getByRole("button", { name: "Zrušit" }).click();
      await page.locator(".mobileCaptureButton").click();
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue(second);
    } finally {
      releaseFirstPut?.();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  test("unsaved task text reaches the suggestion endpoint but never becomes an entity", async ({ page }) => {
    const sentTitles: string[] = [];
    await page.route("**/api/task-suggestions", async (route) => {
      const body = route.request().postDataJSON();
      sentTitles.push(String(body?.title || ""));
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
    });
    const title = `B3 suggestions-only text ${Date.now()}`;
    const modal = page.locator(".captureModal");
    await page.locator(".mobileCaptureButton").click();
    await modal.getByRole("textbox", { name: "Název úkolu" }).fill(title);
    await expect(modal.getByText("Při psaní úkolu se text ještě před uložením odesílá", { exact: false }))
      .toBeVisible();
    await expect.poll(() => sentTitles.includes(title)).toBe(true);
    await modal.getByRole("button", { name: "Zrušit" }).click();
    const snapshot = await page.evaluate(async () =>
      fetch("/api/store", { cache: "no-store" }).then((response) => response.json()));
    expect(snapshot.entities.some((entity: { title: string }) => entity.title === title)).toBe(false);
  });

  test("workspace switching never copies an unsaved draft into another workspace", async ({ page }) => {
    await withSharedCaptureWorkspace(page, async ({ workspaceId }) => {
      const modal = page.locator(".captureModal");
      await page.locator(".mobileCaptureButton").click();
      const destination = modal.getByLabel("Workspace");
      await expect(destination).toHaveValue("personal");
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill("Soukromý rozepsaný úkol B3");
      await destination.selectOption(workspaceId);
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("");
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill("Sdílený rozepsaný úkol B3");
      await destination.selectOption("personal");
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("Soukromý rozepsaný úkol B3");
      await destination.selectOption(workspaceId);
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("Sdílený rozepsaný úkol B3");
      await modal.getByRole("button", { name: "Zrušit" }).click();
      await page.locator(".mobileCaptureButton").click();
      // UI-08a: every standalone open is private, but each workspace keeps its
      // own in-memory draft until reload or sign-out.
      await expect(modal.getByLabel("Workspace")).toHaveValue("personal");
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("Soukromý rozepsaný úkol B3");
      await modal.getByLabel("Workspace").selectOption(workspaceId);
      await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("Sdílený rozepsaný úkol B3");
    });
  });

  test("UI-08a: shared capture needs consent and switching away and back clears it", async ({ page }) => {
    await withSharedCaptureWorkspace(page, async ({ workspaceId, areaId }) => {
      await page.route("**/api/task-suggestions", (route) =>
        route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
      const modal = page.locator(".captureModal");
      await page.locator(".mobileCaptureButton").click();
      const destination = modal.getByLabel("Workspace");
      await expect(destination).toHaveValue("personal");
      await destination.selectOption(workspaceId);
      const approve = modal.getByRole("checkbox", { name: /Potvrzuji, že se tato položka má uložit do sdíleného prostoru/ });
      await expect(approve).toBeVisible();
      await expect(approve).not.toBeChecked();
      await approve.check();
      await destination.selectOption("personal");
      await expect(approve).toHaveCount(0);
      await destination.selectOption(workspaceId);
      await expect(approve).not.toBeChecked();
      const title = `UI-08a explicit shared task ${Date.now()}`;
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill(title);
      await modal.locator(".captureArea select").selectOption(areaId);
      await modal.getByRole("button", { name: "Přidat úkol" }).click();
      await expect(modal).toBeVisible(); // browser validation must not permit unapproved sharing
      await approve.check();
      await modal.getByRole("button", { name: "Přidat úkol" }).click();
      await expect(modal).toHaveCount(0);
      await expect.poll(() => page.evaluate(async ({ title, workspaceId }) => {
        const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
        return snapshot.entities.some((item: { type: string; title: string; workspaceId: string }) =>
          item.type === "task" && item.title === title && item.workspaceId === workspaceId);
      }, { title, workspaceId })).toBe(true);
    });
  });

  test("UI-08a: renaming a proposed shared project requires new consent", async ({ page }) => {
    await withSharedCaptureWorkspace(page, async ({ workspaceId, areaId }) => {
      await page.route("**/api/task-suggestions", (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ suggestion: {
          projectId: "", projectTitle: "", areaId: "", areaTitle: "",
          // #404: native duration input requires at least 1 minute.
          priority: "none", estimatedMinutes: 15, scheduledStart: "",
          scheduledEnd: "", scheduledDate: "", scheduledOptions: [],
          confidence: "medium", reasons: [], constraints: [],
          newProjectSuggestion: {
            title: "Původní návrh", areaId: "", areaTitle: "",
            confidence: "medium", reason: "Společný projekt",
          },
        } }),
      }));
      const modal = page.locator(".captureModal");
      await page.locator(".mobileCaptureButton").click();
      await modal.getByLabel("Workspace").selectOption(workspaceId);
      await modal.getByRole("textbox", { name: "Název úkolu" }).fill("Úkol pro sdílený projekt");
      await expect(modal.getByRole("radio", { name: /Vytvořit nový projekt a přiřadit/ })).toBeVisible();
      await modal.getByRole("radio", { name: /Vytvořit nový projekt a přiřadit/ }).check();
      await modal.locator(".captureArea select").selectOption(areaId);
      const projectName = modal.getByRole("textbox", { name: "Název nového projektu" });
      await expect(projectName).toHaveValue("Původní návrh");
      const approve = modal.getByRole("checkbox", { name: /Potvrzuji, že se tato položka má uložit do sdíleného prostoru/ });
      await approve.check();
      await projectName.fill("Nový sdílený projekt");
      await expect(approve).not.toBeChecked();
      await projectName.fill("Původní návrh");
      await expect(approve).not.toBeChecked(); // returning to an earlier name cannot replay consent
      await projectName.fill("Nový sdílený projekt");
      await approve.check();
      await modal.getByRole("button", { name: "Přidat úkol" }).click();
      await expect(modal).toHaveCount(0);
      await expect.poll(() => page.evaluate(async ({ workspaceId }) => {
        const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
        return snapshot.entities.some((item: { type: string; title: string; workspaceId: string }) =>
          item.type === "project" && item.title === "Nový sdílený projekt" &&
          item.workspaceId === workspaceId);
      }, { workspaceId })).toBe(true);
    });
  });

  test("saving a captured task clears its draft instead of offering a duplicate", async ({ page }) => {
    const title = `B3 uložený úkol ${Date.now()}`;
    await page.route("**/api/task-suggestions", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    const modal = page.locator(".captureModal");
    await page.locator(".mobileCaptureButton").click();
    await modal.getByRole("textbox", { name: "Název úkolu" }).fill(title);
    await expect(modal.locator(".captureSuggestionState.error")).toBeVisible();
    await modal.getByRole("button", { name: "Přidat úkol" }).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async (name) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
      return snapshot.entities.filter((item: { title: string; type: string }) =>
        item.type === "task" && item.title === name).length;
    }, title)).toBe(1);
    await page.locator(".mobileCaptureButton").click();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("");
  });
});
