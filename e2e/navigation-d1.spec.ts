import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { navView, settingsSections, sidebarView, waitUntilSynced } from "./helpers";

// D1 navigation cleanup (owner decisions 2026-10-22): the sidebar, the projects under it, the
// Projects view grouped by area, and mail reading in the Inbox instead of Settings.

// Projects of this scenario only: other scenarios add and delete projects of their own, so nothing here relies on
// the seeded one. The project has no task (the attention dot) and is first in the manual order (the sidebar list).
// `legacyLabel`: a project from before the Area model that has only a free-text area label and no Area link. A new
// project without any Area is filed under "Nezařazeno" by the server (2a part 4), so "Bez oblasti" is only reachable
// with such legacy data.
async function seedProject(page: Page, id: string, title: string, legacyLabel = "") {
  await page.evaluate(async ({ id, title, legacyLabel }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const project = { id, type: "project", title, status: "active", workspaceId: "personal", properties: { manualOrders: { "personal:project:all": -1_000_000 }, ...(legacyLabel ? { area: legacyLabel } : {}) }, createdAt: now, updatedAt: now };
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: [...snapshot.entities, project], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
    if (!response.ok) throw new Error(`Seeding failed: ${response.status}`);
  }, { id, title, legacyLabel });
}
async function removeProject(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: snapshot.entities.filter((row: { id: string }) => row.id !== id),
      // A project carries its Area link (2a part 4): it goes with the project.
      relations: snapshot.relations.filter((row: { sourceEntityId: string; targetEntityId: string }) => row.sourceEntityId !== id && row.targetEntityId !== id),
      deletedIds: [id], revivedIds: [] }) });
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
  await page.locator("aside .secondaryNavToggle").click();
  await expect(page.locator("aside .secondaryNav button")).toHaveText(["Oblasti", "Poznámky", "Po termínu", "Kdykoli", "Někdy", "Dokončené", "Kontext", "Agenti"]);
  await page.locator("aside .secondaryNav button", { hasText: "Oblasti" }).click();
  await expect(page).toHaveURL(/\?view=Areas$/);
  await page.locator("aside .secondaryNav button", { hasText: "Poznámky" }).click();
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
    // B1: a project opens as the main view of Projects, not as an inspector.
    await expect(page.locator(".projectPage .projectActions")).toBeVisible();
    await expect(page.locator(".projectPage")).toHaveAttribute("aria-label", `Stránka projektu: ${title}`);
    await expect(page.locator("aside.detail")).toHaveCount(0);
    // The aggregate has no list: projects of several workspaces under one heading would be confusing.
    await page.locator("aside .workspaceButton").click();
    // Other scenarios leave many shared workspaces behind, so this menu can be taller than the window: click in the page.
    await page.locator('aside .workspaceMenu button[data-workspace-id="all"]').evaluate((button: HTMLElement) => button.click());
    await expect(page.locator("aside .sidebarProjects")).toHaveCount(0);
  } finally {
    await removeProject(page, id);
  }
});

test("Projects are grouped under their area, then a legacy project without an area link under 'Bez oblasti'; reordering stays inside a group", async ({ page }) => {
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = Date.now();
  const ids = { area: `e2e-d1-area-${stamp}`, one: `e2e-d1-p1-${stamp}`, two: `e2e-d1-p2-${stamp}`, loose: `e2e-d1-p3-${stamp}` };
  const put = (add: boolean) => page.evaluate(async ({ ids, add, stamp }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const mine = new Set(Object.values(ids));
    const entity = (id: string, type: string, title: string, createdAt: number, properties: Record<string, unknown> = {}) => ({ id, type, title, status: "active", workspaceId: "personal", properties, createdAt, updatedAt: Date.now() });
    const relation = (id: string, source: string) => ({ id, sourceEntityId: source, targetEntityId: ids.area, relationType: "belongs_to_area", workspaceId: "personal", createdAt: stamp });
    const entities = snapshot.entities.filter((row: { id: string }) => !mine.has(row.id));
    const relations = snapshot.relations.filter((row: { sourceEntityId: string; targetEntityId: string }) => !mine.has(row.sourceEntityId) && !mine.has(row.targetEntityId));
    if (add) {
      entities.push(entity(ids.area, "area", "Oblast D1", stamp), entity(ids.one, "project", "Projekt D1 první", stamp + 1), entity(ids.two, "project", "Projekt D1 druhý", stamp + 2), entity(ids.loose, "project", "Projekt D1 volný", stamp + 3, { area: "Starý štítek" }));
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

// ---- Follow-up fixes after review ----

async function removeByTitle(page: Page, title: string) {
  await page.evaluate(async (title) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const ids = snapshot.entities.filter((row: { title: string }) => row.title === title).map((row: { id: string }) => row.id);
    if (!ids.length) return;
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
      entities: snapshot.entities.filter((row: { id: string }) => !ids.includes(row.id)),
      relations: snapshot.relations.filter((row: { sourceEntityId: string; targetEntityId: string }) => !ids.includes(row.sourceEntityId) && !ids.includes(row.targetEntityId)),
      deletedIds: ids, revivedIds: [] }) });
  }, title);
}

test("a very long project title is cut with an ellipsis inside the sidebar and keeps its full name", async ({ page }) => {
  const id = `e2e-d1-long-${Date.now()}`;
  const title = "Dlouhý název projektu ".repeat(6).slice(0, 120);
  await page.goto("/?view=Today");
  await waitUntilSynced(page);
  await seedProject(page, id, title);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const row = page.locator(`aside [data-sidebar-project="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("title", title);
    const geometry = await page.evaluate((id) => {
      const aside = document.querySelector("aside")!.getBoundingClientRect();
      const row = document.querySelector(`aside [data-sidebar-project="${id}"]`)!;
      const text = row.querySelector(".sidebarProjectTitle")!;
      const scroll = document.querySelector("aside .sidebarScroll")!;
      return { rowRight: row.getBoundingClientRect().right, asideRight: aside.right, truncated: text.scrollWidth > text.clientWidth,
        overflowX: scroll.scrollWidth > scroll.clientWidth, ellipsis: getComputedStyle(text).textOverflow };
    }, id);
    expect(geometry.rowRight).toBeLessThanOrEqual(geometry.asideRight);
    expect(geometry.truncated).toBe(true);
    expect(geometry.ellipsis).toBe("ellipsis");
    expect(geometry.overflowX).toBe(false);
  } finally {
    await removeProject(page, id);
  }
});

for (const [width, height] of [[1280, 720], [1440, 900]] as const) {
  test(`sidebar at ${width}x${height} with More views open: primary list intact, the rest scrolls, footer reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const stamp = Date.now();
    const ids = Array.from({ length: 7 }, (_, index) => `e2e-d1-fill-${stamp}-${index}`);
    await page.goto("/?view=Today");
    await waitUntilSynced(page);
    for (const [index, id] of ids.entries()) await seedProject(page, id, `Projekt D1 výplň ${index}`);
    try {
      await page.reload();
      await waitUntilSynced(page);
      await page.locator("aside .secondaryNavToggle").click();
      await expect(page.locator("aside .secondaryNav button")).toHaveCount(8);
      const aside = page.locator("aside");
      const asideBox = (await aside.boundingBox())!;
      // Primary list: every entry fully inside the window and the sidebar.
      for (const button of await page.locator("aside > nav button").all()) {
        const box = (await button.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(asideBox.y);
        expect(box.y + box.height).toBeLessThanOrEqual(Math.min(asideBox.y + asideBox.height, height));
      }
      // Nothing overflows the sidebar itself.
      expect(await aside.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      // The area under the primary list scrolls and shows a scrollbar when it overflows.
      const scroll = page.locator("aside .sidebarScroll");
      // Headless Chromium hides scrollbars, so their width cannot be measured here: the area must be a scroll container
      // that really overflows when space runs out, with the scrollbar not switched off.
      const metrics = await scroll.evaluate((element: HTMLElement) => ({ overflowing: element.scrollHeight > element.clientHeight,
        overflowY: getComputedStyle(element).overflowY, scrollbarWidth: getComputedStyle(element).scrollbarWidth }));
      expect(["auto", "scroll"]).toContain(metrics.overflowY);
      expect(metrics.scrollbarWidth).not.toBe("none");
      if (height <= 720) expect(metrics.overflowing).toBe(true);
      const scrollBox = (await scroll.boundingBox())!;
      for (const button of await page.locator("aside .secondaryNav button").all()) {
        await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(scrollBox.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height + 1);
      }
      // Footer: New, the More views toggle and Settings stay on screen.
      for (const control of await page.locator("aside .sidebarActions button").all()) {
        const box = (await control.boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        expect(box.y).toBeGreaterThanOrEqual(scrollBox.y + scrollBox.height - 1);
      }
    } finally {
      for (const id of ids) await removeProject(page, id);
    }
  });
}

test("Doručené in the sidebar or the phone bar returns from 'Z pošty' to the task list", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const tab = (name: string) => page.locator(`[data-inbox-tab="${name}"]`);
  await tab("mail").click();
  await expect(tab("mail")).toHaveAttribute("aria-pressed", "true");
  await navView(page, "Inbox").click();
  await expect(tab("tasks")).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await tab("mail").click();
  await expect(tab("mail")).toHaveAttribute("aria-pressed", "true");
  await page.locator('.mobileNav button[data-nav-view="Inbox"]').click();
  await expect(tab("tasks")).toHaveAttribute("aria-pressed", "true");
});

test("batch selection does not survive switching Inbox tabs", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const box = page.locator(".batchRowSelect input:not([disabled])").first();
  await expect(box).toBeVisible();
  await box.check();
  await expect(box).toBeChecked();
  await page.locator('[data-inbox-tab="mail"]').click();
  await page.locator('[data-inbox-tab="tasks"]').click();
  await expect(page.locator(".batchRowSelect input:checked")).toHaveCount(0);
});

const mailAccount = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "follow@example.com" };
const mailMessage = { id: "ab123456789", threadId: "abcdef12", subject: "Zpráva pro úkol D1", from: "alice@example.com", to: mailAccount.email, date: "21. října", snippet: "Náhled", unread: false };

test("after creating a task from a message, 'Zobrazit úkoly' leads back to the task list with the new task", async ({ page }) => {
  const taskTitle = `Úkol z pošty D1 ${Date.now()}`;
  await page.route("**/api/mail/gmail?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [mailAccount] }) }));
  await page.route("**/api/mail/gmail/messages", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [mailMessage] }) }));
  await page.route("**/api/mail/gmail/message", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { ...mailMessage, text: "Text zprávy", truncated: false } }) }));
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  try {
    await page.locator('[data-inbox-tab="mail"]').click();
    const reader = page.locator(".mailReader");
    await reader.getByRole("button", { name: "Doručené" }).click();
    await reader.getByRole("button", { name: "Přečíst zprávu" }).click();
    await reader.getByLabel("Název úkolu").fill(taskTitle);
    await reader.getByRole("button", { name: "Potvrdit a vytvořit úkol" }).click();
    await expect(reader).toContainText("Úkol byl vytvořen v Inboxu.");
    await reader.getByRole("button", { name: "Zobrazit úkoly" }).click();
    await expect(page.locator('[data-inbox-tab="tasks"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mailReader")).toHaveCount(0);
    await expect(page.getByText(taskTitle, { exact: true }).first()).toBeVisible();
  } finally {
    await expect.poll(() => page.evaluate(async (title) => (await fetch("/api/store", { cache: "no-store" }).then((r) => r.json())).entities.some((e: { title: string }) => e.title === title), taskTitle)).toBe(true).catch(() => undefined);
    await removeByTitle(page, taskTitle);
  }
});

test("'Open source message' with accounts that fail to load shows the load error, not 'no longer connected', and opens nothing later", async ({ page }) => {
  const title = `Úkol se zdrojem D1 ${Date.now()}`;
  const id = `e2e-d1-source-${Date.now()}`;
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.evaluate(async ({ id, title, account }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const task = { id, type: "task", title, status: "open", workspaceId: "personal", createdAt: now, updatedAt: now,
      properties: { inbox: true, mailSource: { provider: "gmail", accountId: account, messageId: "ab123456789", threadId: "abcdef12" } } };
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities: [...snapshot.entities, task], relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  }, { id, title, account: mailAccount.id });
  let accountsWork = false;
  let detailRequests = 0;
  await page.route("**/api/mail/gmail?*", (route) => accountsWork
    ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [mailAccount] }) })
    : route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' }));
  await page.route("**/api/mail/gmail/message", (route) => { detailRequests += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: { ...mailMessage, text: "Text zprávy", truncated: false } }) }); });
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator("article", { hasText: title }).first().locator(".taskRowOpen").click();
    await page.locator("aside.detail").getByRole("button", { name: "Otevřít zdrojovou zprávu" }).click();
    const reader = page.locator(".mailReader");
    await expect(reader).toContainText("Nepodařilo se načíst účty");
    await expect(reader).not.toContainText("již není připojen");
    // Later, with the accounts available again, nothing opens by itself.
    accountsWork = true;
    await navView(page, "Inbox").click();
    await page.locator('[data-inbox-tab="mail"]').click();
    await expect(page.locator(".mailReader").getByText("follow@example.com")).toBeVisible();
    await expect(page.getByRole("region", { name: "Detail e-mailu" })).toHaveCount(0);
    expect(detailRequests).toBe(0);
  } finally {
    await removeByTitle(page, title);
  }
});

test("a legacy project without an area link is listed under 'Bez oblasti'", async ({ page }) => {
  const id = `e2e-d1-loose-${Date.now()}`;
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await seedProject(page, id, "Projekt D1 bez oblasti", "Starý štítek");
  try {
    await page.reload();
    await waitUntilSynced(page);
    const loose = page.locator('[data-project-group="none"]');
    await expect(loose.getByRole("heading", { name: "Bez oblasti" })).toBeVisible();
    await expect(loose.locator(".taskRowOpen", { hasText: "Projekt D1 bez oblasti" })).toBeVisible();
  } finally {
    await removeProject(page, id);
  }
});
