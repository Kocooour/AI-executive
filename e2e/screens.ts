import { expect, type Page } from "@playwright/test";
import { waitUntilSynced } from "./helpers";

// The main screens and states of the signed-in app, visited one after another. `record` is called
// on each with a name for it; the audits (contrast, language) decide what to check there.
export const views = ["Home", "Inbox", "Today", "Upcoming", "Anytime", "Someday", "Overdue", "Completed", "Projects", "Areas", "Notes", "Calendar", "Search", "Context", "Agents", "Settings"];

export async function visitScreens(page: Page, record: (where: string) => Promise<void>, theme?: "light" | "dark") {
  for (const view of views) {
    await page.goto(`/?view=${view}`);
    await waitUntilSynced(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme ?? /light|dark/);
    await record(view);
  }
  await page.goto("/");
  await waitUntilSynced(page);
  await page.locator("aside .workspaceButton").first().click();
  await expect(page.locator("aside .workspaceMenu")).toBeVisible();
  await record("Workspace chooser");
  await page.goto("/");
  await waitUntilSynced(page);
  await page.locator(".attentionMore summary").first().click();
  await page.locator(".attentionLimits summary").first().click();
  await record("Home, attention details");
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  // By class, so that the walk works in both interface languages.
  const sections = page.locator(".settingsTabs button");
  for (let index = 0; index < await sections.count(); index += 1) {
    await sections.nth(index).click();
    await record(`Settings: ${await sections.nth(index).innerText()}`);
  }
  await page.goto("/?task=e2e-plain");
  await expect(page.locator("input.titleEdit")).toBeVisible();
  await record("Task detail");
  // Its own project: other scenarios may have deleted the seeded one.
  await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    if (snapshot.entities.some((entity: { id: string }) => entity.id === "e2e-contrast-project")) return;
    const now = Date.now();
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: [...snapshot.entities, { id: "e2e-contrast-project", type: "project", title: "Projekt pro kontrolu kontrastu", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now }],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) }).then((response) => { if (!response.ok) throw new Error(`Seeding the project failed: ${response.status}`); });
  });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await page.getByText("Projekt pro kontrolu kontrastu").first().click();
  await record("Project detail");
  await page.locator(".projectActions button.danger").click();
  await expect(page.locator("dialog.confirmDialog")).toBeVisible();
  await record("Confirmation dialog");
  await page.keyboard.press("Escape");
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.locator("button", { hasText: "＋" }).first().click();
  await page.locator(".captureModal").locator("input, textarea").first().fill("Kontrola kontrastu 25. 10. !");
  await expect(page.locator(".captureSuggestion, .capturePreview").first()).toBeVisible();
  await record("Capture dialog");
  await page.keyboard.press("Escape");
  await page.locator("button", { hasText: /Zeptat se AI|Ask AI/ }).first().click();
  await expect(page.locator(".assistantPanel")).toBeVisible();
  await record("Assistant");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitUntilSynced(page);
  await record("Phone: Home");
  await page.locator(".mobileNav button").last().click();
  await record("Phone: More");
}
