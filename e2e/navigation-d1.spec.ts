import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { navView, settingsSections, sidebarView, waitUntilSynced } from "./helpers";

// D1 navigation cleanup (owner decisions 2026-10-22): the sidebar, the projects under it, the
// Projects view grouped by area, and mail reading in the Inbox instead of Settings.

// Projects of this scenario only: other scenarios add and delete projects of their own, so nothing here relies on
// the seeded one. The project has no task (the attention dot) and is first in the manual order (the sidebar list).
async function seedProject(page: Page, id: string, title: string) {
  await page.evaluate(async ({ id, title }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const project = { id, type: "project", title, status: "active", workspaceId: "personal", properties: { manualOrders: { "personal:project:all": -1_000_000 } }, createdAt: now, updatedAt: now };
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: [...snapshot.entities, project], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    if (!response.ok) throw new Error(`Seeding failed: ${response.status}`);
  }, { id, title });
}
async function removeProject(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: snapshot.entities.filter((row: { id: string }) => row.id !== id),
      relations: snapshot.relations, deletedIds: [id], revivedIds: [] }) });
  }, id);
}

test("desktop sidebar: primary views in the approved order, counts only on Inbox and Today", async ({ page }) => {
  const id = `e2e-d1-dot-${Date.now()}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await seedProject(page, id, "Projekt D1 bez úkolu");
  await page.reload();
  await waitUntilSynced(page);
  try {
  const primary = page.locator("aside > nav button");
  expect(await primary.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-nav-view")))).toEqual(
    ["Home", "Inbox", "Today", "Upcoming", "Projects", "Calendar"]);
  await expect(primary).toHaveText([/Domů/, /Doručené/, /Dnes/, /Nadcházející/, /Projekty/, /Kalendář/]);
  // Areas, Notes and Search are not primary any more.
  for (const view of ["Areas", "Notes", "Search"]) await expect(page.locator(`aside > nav [data-nav-view="${view}"]`)).toHaveCount(0);
  // Counts only where they mean work to do.
  await expect(page.locator('aside > nav [data-nav-view="Inbox"] .navCount')).toHaveCount(1);
  await expect(page.locator('aside > nav [data-nav-view="Today"] .navCount')).toHaveCount(1);
  for (const view of ["Home", "Upcoming", "Projects", "Calendar"]) await expect(page.locator(`aside > nav [data-nav-view="${view}"] .navCount`)).toHaveCount(0);
  // The seeded project has no open task, so Projects shows the attention dot with accessible text.
  const dot = page.locator('aside > nav [data-nav-view="Projects"] .navDot');
  await expect(dot).toHaveCount(1);
  await expect(page.locator('aside > nav [data-nav-view="Projects"]')).toContainText("vyžaduje pozornost");
  await expect(page.locator('aside > nav [data-nav-view="Inbox"] .navDot')).toHaveCount(0);
  } finally {
    await removeProject(page, id);
  }
});

test("More views lists Areas, Notes, Overdue, Anytime, Someday, Completed, Context and Agents; Search stays global", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  await page.locator("aside details.secondaryNav summary").click();
  await expect(page.locator("aside details.secondaryNav button")).toHaveText(["Oblasti", "Poznámky", "Po termínu", "Kdykoli", "Někdy", "Dokončené", "Kontext", "Agenti"]);
  await page.locator("aside details.secondaryNav button", { hasText: "Oblasti" }).click();
  await expect(page).toHaveURL(/\?view=Areas$/);
  await page.locator("aside details.secondaryNav button", { hasText: "Poznámky" }).click();
  await expect(page).toHaveURL(/\?view=Notes$/);
  // Search: the topbar field and Ctrl/Cmd+K still open it from anywhere.
  await sidebarView(page, "Dnes").click();
  await page.keyboard.press("Control+k");
  await expect(page).toHaveURL(/\?view=Search$/);
  await expect(page.locator(".searchField input")).toBeFocused();
});

test("active projects are listed under the navigation and open like in the Projects list", async ({ page }) => {
  const id = `e2e-d1-side-${Date.now()}`;
  const title = "Projekt D1 v postranním panelu";
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await seedProject(page, id, title);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const list = page.locator("aside .sidebarProjects");
    await expect(list).toBeVisible();
    expect(await list.locator("button").count()).toBeLessThanOrEqual(7);
    const row = list.locator("button", { hasText: title });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator("aside.detail .projectActions")).toBeVisible();
    await expect(page.locator("aside.detail")).toHaveAttribute("aria-label", `Projekt: ${title}`);
    // The aggregate has no list: projects of several workspaces under one heading would be confusing.
    await page.locator("aside .workspaceButton").click();
    // Other scenarios leave many shared workspaces behind, so this menu can be taller than the window: click in the page.
    await page.locator('aside .workspaceMenu button[data-workspace-id="all"]').evaluate((button: HTMLElement) => button.click());
    await expect(page.locator("aside .sidebarProjects")).toHaveCount(0);
  } finally {
    await removeProject(page, id);
  }
});

test("Projects are grouped under their area, then 'Bez oblasti'; reordering stays inside a group", async ({ page }) => {
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = Date.now();
  const ids = { area: `e2e-d1-area-${stamp}`, one: `e2e-d1-p1-${stamp}`, two: `e2e-d1-p2-${stamp}`, loose: `e2e-d1-p3-${stamp}` };
  const put = (add: boolean) => page.evaluate(async ({ ids, add, stamp }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const mine = new Set(Object.values(ids));
    const entity = (id: string, type: string, title: string, createdAt: number) => ({ id, type, title, status: "active", workspaceId: "personal", properties: {}, createdAt, updatedAt: Date.now() });
    const relation = (id: string, source: string) => ({ id, sourceEntityId: source, targetEntityId: ids.area, relationType: "belongs_to_area", workspaceId: "personal", createdAt: stamp });
    const entities = snapshot.entities.filter((row: { id: string }) => !mine.has(row.id));
    const relations = snapshot.relations.filter((row: { sourceEntityId: string; targetEntityId: string }) => !mine.has(row.sourceEntityId) && !mine.has(row.targetEntityId));
    if (add) {
      entities.push(entity(ids.area, "area", "Oblast D1", stamp), entity(ids.one, "project", "Projekt D1 první", stamp + 1), entity(ids.two, "project", "Projekt D1 druhý", stamp + 2), entity(ids.loose, "project", "Projekt D1 volný", stamp + 3));
      relations.push(relation(`e2e-d1-r1-${stamp}`, ids.one), relation(`e2e-d1-r2-${stamp}`, ids.two));
    }
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities, relations,
      deletedIds: add ? [] : [...mine], revivedIds: [] }) });
    if (!response.ok) throw new Error(`Seeding failed: ${response.status}`);
  }, { ids, add, stamp });
  await put(true);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const group = page.locator(`[data-project-group="${ids.area}"]`);
    await expect(group.getByRole("heading", { name: "Oblast D1" })).toBeVisible();
    await expect(group.locator(".taskRowOpen")).toHaveText(["Projekt D1 první", "Projekt D1 druhý"]);
    const loose = page.locator('[data-project-group="none"]');
    await expect(loose.getByRole("heading", { name: "Bez oblasti" })).toBeVisible();
    await expect(loose.locator(".taskRowOpen", { hasText: "Projekt D1 volný" })).toBeVisible();
    await expect(loose.locator(".taskRowOpen", { hasText: "Projekt D1 první" })).toHaveCount(0);
    // "Bez oblasti" comes last; the add-project row is still there.
    const headings = await page.locator(".projectGroupHeading").allInnerTexts();
    expect(headings.at(-1)).toBe("Bez oblasti");
    await expect(page.getByPlaceholder("+ Přidat projekt")).toBeVisible();
    // Keyboard reorder moves a project inside its group; at the edge of the group it does nothing.
    const handle = group.locator("article", { hasText: "Projekt D1 druhý" }).locator(".dragHandle");
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    await expect(group.locator(".taskRowOpen")).toHaveText(["Projekt D1 první", "Projekt D1 druhý"]);
    await page.keyboard.press("ArrowUp");
    await expect(group.locator(".taskRowOpen")).toHaveText(["Projekt D1 druhý", "Projekt D1 první"]);
    await expect(loose.locator(".taskRowOpen", { hasText: "Projekt D1 volný" })).toBeVisible();
  } finally {
    await put(false);
  }
});

test("Settings -> Mail keeps the connection and sync controls and points to the Inbox reader", async ({ page }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByRole("button", { name: "Připojit Gmail" })).toBeVisible();
  await expect(section.getByRole("button", { name: "Doručené" })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Přečíst zprávu" })).toHaveCount(0);
  await expect(section.getByLabel("Hledat v Gmailu")).toHaveCount(0);
});

test("Inbox 'Z pošty' without a connected account explains how to connect and leads to Settings", async ({ page }) => {
  // The shared instance may hold a connected account from another scenario; this one has none.
  await page.route("**/api/mail/gmail?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [] }) }));
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const tabs = page.getByRole("group", { name: "Zdroj Doručených" });
  await expect(tabs.getByRole("button", { name: "Úkoly" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".batchTriage, .batchTriageReadOnly, .taskRowList").first()).toBeVisible();
  await tabs.getByRole("button", { name: "Z pošty" }).click();
  await expect(tabs.getByRole("button", { name: "Z pošty" })).toHaveAttribute("aria-pressed", "true");
  const reader = page.locator(".mailReader");
  await expect(reader).toContainText("není připojený žádný účet Gmail");
  // The task list and its capture row are not shown under the mail tab.
  await expect(page.locator(".taskRowList")).toHaveCount(0);
  await reader.getByRole("button", { name: "Otevřít Nastavení → Pošta" }).click();
  await expect(page).toHaveURL(/\?view=Settings$/);
  await expect(settingsSections(page).filter({ hasText: "Pošta" })).toHaveAttribute("aria-current", "page");
  // Leaving the Inbox returns it to its tasks.
  await navView(page, "Inbox").click();
  await expect(page.getByRole("group", { name: "Zdroj Doručených" }).getByRole("button", { name: "Úkoly" })).toHaveAttribute("aria-pressed", "true");
});

test("phone: the mail reader fits at 390px and Projects is in the bottom bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.locator('[data-inbox-tab="mail"]').click();
  await expect(page.locator(".mailReader")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('.mobileNav button[data-nav-view="Projects"]').click();
  await expect(page).toHaveURL(/\?view=Projects$/);
  await expect(page.locator('.mobileNav button[data-nav-view="Projects"]')).toHaveAttribute("aria-current", "page");
});
