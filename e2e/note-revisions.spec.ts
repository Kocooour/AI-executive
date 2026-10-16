import { expect, test } from "./fixtures";
import { expectOnServer, waitUntilSynced } from "./helpers";

async function seedNote(page: import("@playwright/test").Page, id: string, title: string, content = "") {
  await page.evaluate(async ([noteId, noteTitle, noteContent]) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: [...snapshot.entities, { id: noteId, type: "note", title: noteTitle, content: noteContent, status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now }],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  }, [id, title, content]);
}

async function openNote(page: import("@playwright/test").Page, id: string) {
  await page.goto("/");
  await waitUntilSynced(page);
  await page.goto(`/?task=${id}`);
  await expect(page.getByLabel("Text poznámky").first()).toBeVisible();
  await waitUntilSynced(page);
}

const serverContent = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate((noteId) => fetch("/api/store", { cache: "no-store" }).then((response) => response.json())
    .then((snapshot) => (snapshot.entities.find((entity: { id: string }) => entity.id === noteId) as { content?: string } | undefined)?.content), id);

test("a note body is edited, saved on leaving the field and previewed as safe Markdown", async ({ page }) => {
  const id = `e2e-note-body-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Neutral note");
  const requested: string[] = [];
  page.on("request", (request) => { if (request.url().includes("e2e-image-probe")) requested.push(request.url()); });
  await openNote(page, id);
  const body = "# Heading one\n\n- first item\n- second item\n\n- [ ] open box\n- [x] done box\n\n<script>window.__probe = 1</script>\n\n<img src=\"/e2e-image-probe.png\" onerror=\"window.__probe = 2\">\n\n![alt words](/e2e-image-probe.png)\n\n[bad](javascript:window.__probe=3) and [good](https://example.com)";
  const field = page.getByLabel("Text poznámky").first();
  await field.fill(body);
  await page.locator("input.titleEdit").focus();
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe(body);
  await expect(page.locator(".noteStatus[data-state]")).toHaveText("Uloženo", { timeout: 20_000 });
  await page.getByRole("button", { name: "Náhled" }).click();
  const preview = page.locator(".markdownText").first();
  await expect(preview.getByRole("heading", { name: "Heading one" })).toBeVisible();
  await expect(preview.locator("ul li")).toHaveCount(4);
  await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(preview.locator("img, script")).toHaveCount(0);
  await expect(preview).toContainText("[alt words]");
  await expect(preview.getByRole("link", { name: "good" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(preview.getByRole("link", { name: "good" })).toHaveAttribute("target", "_blank");
  await expect(preview.getByRole("link", { name: "bad" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __probe?: number }).__probe)).toBeUndefined();
  expect(requested).toEqual([]);
  await expect(page.getByRole("button", { name: "Náhled" })).toHaveAttribute("aria-pressed", "true");
});

test("the version history lists versions with changes, shows a diff and restores a version as a new one", async ({ page }) => {
  const id = `e2e-note-history-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "History note", "first line\nshared line");
  await openNote(page, id);
  const list = page.locator(".revisionList");
  await expect(list.locator("li")).toHaveCount(1, { timeout: 20_000 });
  const field = page.getByLabel("Text poznámky").first();
  await field.fill("first line\nshared line\nadded line");
  await page.locator("input.titleEdit").focus();
  await expect(list.locator("li")).toHaveCount(2, { timeout: 20_000 });
  await field.fill("changed text");
  await page.locator("input.titleEdit").focus();
  await expect(list.locator("li")).toHaveCount(3, { timeout: 20_000 });
  await expect(list.locator("li").first()).toContainText("Verze 3");
  await expect(list.locator("li").first()).toContainText("znaků");
  // The oldest version is shown against the current text with marked lines.
  await list.locator("li").last().getByRole("button").click();
  const diff = page.locator(".revisionDiff");
  await expect(diff).toContainText("- first line");
  await expect(diff).toContainText("- shared line");
  await expect(diff).toContainText("+ changed text");
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await expect(page.locator(".noteStatus", { hasText: "Předchozí text zůstává uložen" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe("first line\nshared line");
  await expect(list.locator("li")).toHaveCount(4, { timeout: 20_000 });
  await expect(list.locator("li").first()).toContainText("Verze 4");
  await expect(list.locator("li").first()).toContainText("stejný text jako verze 1");
  await expect(field).toHaveValue("first line\nshared line");
});

test("a note body typed but not yet saved survives a reload", async ({ page }) => {
  const id = `e2e-note-draft-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Draft note", "start");
  await openNote(page, id);
  const typed = `typed before reload ${Date.now()}`;
  await page.getByLabel("Text poznámky").first().fill(typed);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ai-executive-notes-drafts:")).length)).toBeGreaterThan(0);
  await page.reload();
  await page.goto(`/?task=${id}`);
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue(typed, { timeout: 20_000 });
  await expect.poll(() => serverContent(page, id), { timeout: 20_000 }).toBe(typed);
});

test("the note editor fits a phone width and its buttons are large enough", async ({ page }) => {
  const id = `e2e-note-layout-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedNote(page, id, "Layout note", "a very long line ".repeat(20) + "\n\n```\n" + "x".repeat(200) + "\n```");
  await page.setViewportSize({ width: 390, height: 844 });
  await openNote(page, id);
  await expect(page.locator(".revisionList li")).toHaveCount(1, { timeout: 20_000 });
  await page.getByRole("button", { name: "Náhled" }).click();
  await page.locator(".revisionList li button").first().click();
  await expect(page.locator(".revisionDiff")).toBeVisible();
  const metrics = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    detail: (document.querySelector(".detail") as HTMLElement).scrollWidth - (document.querySelector(".detail") as HTMLElement).clientWidth,
    buttons: [...document.querySelectorAll(".noteModeToggle button, .revisionList button, .revisionRestore")].map((element) => element.getBoundingClientRect().height),
  }));
  expect(metrics.page).toBeLessThanOrEqual(0);
  expect(metrics.detail).toBeLessThanOrEqual(0);
  for (const height of metrics.buttons) expect(height).toBeGreaterThanOrEqual(44);
});
