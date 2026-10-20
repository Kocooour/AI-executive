import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

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
    await expect(modal.getByText("Zavřením rozepsané zadání", { exact: false })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Úkol" })).toHaveAttribute("aria-pressed", "true");
    await modal.getByRole("button", { name: "Poznámka" }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("");
    await modal.getByRole("textbox", { name: "Název poznámky" }).fill("B3 vlastní koncept poznámky");
    await modal.getByRole("button", { name: "Úkol" }).click();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("B3 rozepsaný úkol bez uložení");

    await modal.getByRole("button", { name: "Zrušit" }).click();
    await expect(modal).toHaveCount(0);
    await page.locator('.mobileNav button[data-nav-view="Today"]').click();
    await open();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("B3 rozepsaný úkol bez uložení");
    await modal.getByRole("button", { name: "Poznámka" }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("B3 vlastní koncept poznámky");
    await modal.getByRole("button", { name: "Zahodit koncept" }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("");
    await modal.getByRole("button", { name: "Úkol" }).click();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("B3 rozepsaný úkol bez uložení");
    await modal.getByRole("button", { name: "Zrušit" }).click();

    // This iteration intentionally stores no unfinished private text persistently.
    await page.reload();
    await waitUntilSynced(page);
    await open();
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("");
    await modal.getByRole("button", { name: "Poznámka" }).click();
    await expect(modal.getByRole("textbox", { name: "Název poznámky" })).toHaveValue("");
  });

  test("workspace switching never copies an unsaved draft into another workspace", async ({ page }) => {
    const workspaceId = await page.evaluate(async () => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
      const now = Date.now(), id = `e2e-b3-workspace-${now}`;
      const record = {
        id: `workspace:${id}`, type: "workspace", title: "B3 druhý prostor",
        status: "active", workspaceId: id, properties: {
          kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }],
        }, createdAt: now, updatedAt: now,
      };
      const result = await fetch("/api/store", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
          entities: [...snapshot.entities, record], relations: snapshot.relations,
          deletedIds: [], revivedIds: [],
        }),
      });
      if (!result.ok) throw new Error(`B3 workspace fixture: ${result.status}`);
      return id;
    });
    await page.reload();
    await waitUntilSynced(page);
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
    // The write workspace remains selected, without leaking the other title.
    await expect(modal.getByLabel("Workspace")).toHaveValue(workspaceId);
    await expect(modal.getByRole("textbox", { name: "Název úkolu" })).toHaveValue("Sdílený rozepsaný úkol B3");
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
