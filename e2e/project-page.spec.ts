import type { Browser, Page } from "@playwright/test";
import { sessionFile } from "../playwright.config";
import { expect, test } from "./fixtures";
import { expectOnServer, waitUntilSynced } from "./helpers";

// B1: project context and the project page (owner decisions 2026-10-22, proposal §4). Every scenario seeds records of its own
// (ids with a stamp) and removes them again: the e2e instance is shared by the scenarios.

type Seed = { entities: Array<Record<string, unknown>>; relations?: Array<Record<string, unknown>> };

// A save that meets a newer revision (409) is repeated with a fresh snapshot, at most three times.
async function seed(page: Page, data: Seed) {
  return page.evaluate(async (data) => {
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const ids = new Set(data.entities.map((entity) => entity.id));
      const relationIds = new Set((data.relations || []).map((relation) => relation.id));
      const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities.filter((row: { id: string }) => !ids.has(row.id)), ...data.entities],
        relations: [...snapshot.relations.filter((row: { id: string }) => !relationIds.has(row.id)), ...(data.relations || [])],
        deletedIds: [], revivedIds: [] }) });
      status = response.status;
      if (status !== 409) break;
    }
    return status;
  }, data);
}

async function cleanup(page: Page, ids: string[]) {
  const status = await page.evaluate(async (ids) => {
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const gone = new Set(ids);
      const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: snapshot.entities.filter((row: { id: string }) => !gone.has(row.id)),
        relations: snapshot.relations.filter((row: { sourceEntityId: string; targetEntityId: string }) => !gone.has(row.sourceEntityId) && !gone.has(row.targetEntityId)),
        deletedIds: ids, revivedIds: [] }) });
      status = response.status;
      if (status !== 409) break;
    }
    return status;
  }, ids);
  expect(status).toBe(200);
}

// Titles carry a tag of this run, so records left behind by another run can never match a locator.
const R = Date.now().toString(36).slice(-5);
const now = () => Date.now();
const entity = (id: string, type: string, title: string, properties: Record<string, unknown> = {}, status = "open") =>
  ({ id, type, title, status: type === "task" ? status : "active", workspaceId: "personal", properties, createdAt: now(), updatedAt: now() });
const member = (stamp: number, task: string, project: string) =>
  ({ id: `r-${task}`, sourceEntityId: task, targetEntityId: project, relationType: "belongs_to_project", workspaceId: "personal", createdAt: stamp });
const inArea = (stamp: number, project: string, area: string) =>
  ({ id: `ra-${project}`, sourceEntityId: project, targetEntityId: area, relationType: "belongs_to_area", workspaceId: "personal", createdAt: stamp });

function ids(stamp: number) {
  return { area: `e2e-b1-area-${stamp}`, rich: `e2e-b1-rich-${stamp}`, bare: `e2e-b1-bare-${stamp}`, old: `e2e-b1-old-${stamp}`,
    t1: `e2e-b1-t1-${stamp}`, t2: `e2e-b1-t2-${stamp}`, t3: `e2e-b1-t3-${stamp}`, done: `e2e-b1-done-${stamp}`, note: `e2e-b1-note-${stamp}` };
}

async function seedWorld(page: Page, stamp: number) {
  const id = ids(stamp);
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const status = await seed(page, {
    entities: [
      entity(id.area, "area", `Oblast B1${R}`),
      entity(id.rich, "project", `Projekt B1${R} s kontextem`, {
        context: { why: "Současný web neprodává. Brzdí také nábor.", goals: ["Spustit do 30. 11.", "Udržet SEO"], doneWhen: "Web běží na produkční doméně", provenance: "owner", updatedAt: stamp } }),
      entity(id.bare, "project", `Projekt B1${R} bez kontextu`),
      entity(id.old, "project", `Projekt B1${R} starý cíl`, { goal: "Starý cíl projektu zůstane vidět" }),
      entity(id.t1, "task", `Úkol B1${R} první`, { deadline: day }),
      entity(id.t2, "task", `Úkol B1${R} druhý`),
      entity(id.done, "task", `Úkol B1${R} hotový`, {}, "completed"),
      entity(id.note, "note", `Poznámka B1${R}`),
    ],
    relations: [inArea(stamp, id.rich, id.area), inArea(stamp, id.bare, id.area), member(stamp, id.t1, id.rich), member(stamp, id.t2, id.rich),
      member(stamp, id.done, id.rich), member(stamp, id.note, id.rich)],
  });
  expect(status).toBe(200);
  return id;
}

test("project list: first sentence of why, progress, next step and one attention label, grouped by area", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const id = await seedWorld(page, stamp);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const group = page.locator(`[data-project-group="${id.area}"]`);
    const rich = group.locator(".taskRow", { hasText: `Projekt B1${R} s kontextem` });
    await expect(rich.locator("[data-project-why]")).toHaveText("Současný web neprodává.");
    await expect(rich.locator(".taskRowMeta")).toHaveText("1/3 kroků");
    await expect(rich.locator("[data-project-next]")).toContainText(`Další krok: Úkol B1${R} první`);
    await expect(rich.locator("[data-project-attention]")).toHaveText("1 po termínu");
    // Without context the row asks for it, instead of leaving the place empty; without any task it says so, once.
    const bare = group.locator(".taskRow", { hasText: `Projekt B1${R} bez kontextu` });
    await expect(bare.locator("[data-project-why]")).toHaveText("Doplňte, proč je projekt důležitý");
    await expect(bare.locator(".taskRowMeta")).toHaveText("Zatím bez kroků");
    await expect(bare.locator("[data-project-attention]")).toHaveText("bez dalšího kroku");
    await expect(bare.locator("[data-project-attention]")).toHaveCount(1);
    // The former goal is read as "Hotovo, když" even before anything was saved.
    const loose = page.locator('[data-project-group="none"]').locator(".taskRow", { hasText: `Projekt B1${R} starý cíl` });
    await expect(loose).toBeVisible();
  } finally {
    await cleanup(page, Object.values(id));
  }
});

test("opening a project shows its page as the main view; a task opens the inspector over it; Back returns to the list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const id = await seedWorld(page, stamp);
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: `Projekt B1${R} s kontextem` }).getByRole("button", { name: `Projekt B1${R} s kontextem`, exact: true }).click();
    const projectPage = page.locator(".projectPage");
    await expect(projectPage).toBeVisible();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/\?view=Projects$/);
    // Header: title, status, progress and the context.
    await expect(projectPage.getByRole("textbox", { name: "Název projektu" })).toHaveValue(`Projekt B1${R} s kontextem`);
    await expect(page.getByTestId("project-status")).toHaveText("Aktivní");
    await expect(page.getByTestId("project-progress")).toContainText("1/3 kroků");
    await expect(projectPage.getByRole("textbox", { name: "Proč je důležitý" })).toHaveValue("Současný web neprodává. Brzdí také nábor.");
    await expect(projectPage.getByRole("textbox", { name: "Hlavní cíle 1" })).toHaveValue("Spustit do 30. 11.");
    await expect(projectPage.getByRole("textbox", { name: "Hotovo, když" })).toHaveValue("Web běží na produkční doméně");
    await expect(projectPage.locator(".projectContextHint")).toHaveText("Lumi může navrhnout znění, uloží se až po vašem schválení.");
    // The tasks are ordinary list rows with their actions; the notes are rows too.
    await expect(projectPage.locator(".projectTaskList .taskRow")).toHaveCount(2);
    await expect(projectPage.locator(".projectNoteList .taskRow", { hasText: `Poznámka B1${R}` })).toBeVisible();
    // "Podrobnosti" is collapsed and holds the area (exactly one) and the rest.
    const details = projectPage.locator(".projectDetails");
    await expect(details).not.toHaveAttribute("open", "");
    await details.locator("summary").click();
    await expect(details.getByLabel("Oblast", { exact: true })).toHaveValue(id.area);
    await expect(details.getByText("Poslední aktivita")).toBeVisible();
    await expect(details.getByText("Co Lumi ví")).toBeVisible();
    await expect(details.getByText("Historie")).toBeVisible();

    // Completing a step from the page moves the progress.
    await projectPage.locator(".taskRow", { hasText: `Úkol B1${R} druhý` }).locator(".check").click();
    await expect(page.getByTestId("project-progress")).toContainText("2/3 kroků");

    // A task opened from the page uses the inspector; the project page stays under it.
    await projectPage.locator(".taskRow", { hasText: `Úkol B1${R} první` }).getByRole("button", { name: `Úkol B1${R} první`, exact: true }).click();
    await expect(page.locator("aside.inspectorDetail")).toHaveAttribute("aria-label", `Úkol: Úkol B1${R} první`);
    await expect(projectPage).toBeVisible();
    await page.locator("aside.inspectorDetail button.close").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(projectPage).toBeVisible();

    // Back returns to the list; so does the browser's Back, and the Projects entry of the navigation.
    await page.locator(".projectBack").click();
    await expect(projectPage).toHaveCount(0);
    await expect(page.locator(`[data-project-group="${id.area}"]`)).toBeVisible();
    await page.locator(".taskRow", { hasText: `Projekt B1${R} bez kontextu` }).getByRole("button", { name: `Projekt B1${R} bez kontextu`, exact: true }).click();
    await expect(projectPage).toBeVisible();
    await page.goBack();
    await expect(projectPage).toHaveCount(0);
    await page.goForward();
    await expect(projectPage).toBeVisible();
    await page.locator(".projectBack").click();
    await page.locator(".taskRow", { hasText: `Projekt B1${R} bez kontextu` }).getByRole("button", { name: `Projekt B1${R} bez kontextu`, exact: true }).click();
    await expect(projectPage).toBeVisible();
    await page.locator('aside > nav [data-nav-view="Projects"]').click();
    await expect(projectPage).toHaveCount(0);
  } finally {
    await cleanup(page, Object.values(id));
  }
});

test("Home sidebar project creates list→page history, Back/Forward restore each step", async ({ page }) => {
  await page.goto("/?view=Home");
  await waitUntilSynced(page);
  const id = `e2e-b1-side-${now()}`;
  const title = `Projekt B1${R} v navigaci`;
  // Pin the test project to the top of the sidebar: other focused tests may have left more projects.
  expect(await seed(page, { entities: [entity(id, "project", title,
    { manualOrders: { "personal:project:all": -1_000_000 } })] })).toBe(200);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const sidebar = page.locator("aside .sidebarProjects button", { hasText: title });
    await expect(sidebar).toBeVisible();
    await sidebar.click();
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", id);
    await expect(page).toHaveURL(/\?view=Projects$/);
    await page.goBack();
    await expect(page.locator(".projectPage")).toHaveCount(0);
    await expect(page.locator(".taskRow", { hasText: title })).toBeVisible();
    await page.goBack();
    await expect(page.locator(".projectPage")).toHaveCount(0);
    await expect(page).not.toHaveURL(/\?view=Projects$/);
    await page.goForward();
    await expect(page.locator(".taskRow", { hasText: title })).toBeVisible();
    await page.goForward();
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", id);
  } finally {
    await cleanup(page, [id]);
  }
});

test("context is edited in place with a visible save state, stored as one object with provenance and the old goal mirrored", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const id = await seedWorld(page, stamp);
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: `Projekt B1${R} bez kontextu` }).getByRole("button", { name: `Projekt B1${R} bez kontextu`, exact: true }).click();
    const context = page.locator(".projectContext");
    // Empty state: the hint is the placeholder, not an empty place.
    await expect(context.getByRole("textbox", { name: "Proč je důležitý" })).toHaveAttribute("placeholder", "Doplňte, proč je projekt důležitý");
    await expect(context).toHaveAttribute("data-context-empty", "true");
    await context.getByRole("textbox", { name: "Proč je důležitý" }).fill("Bez toho nejde kampaň. Druhá věta.");
    // Typing starts once the new goal field has focus, as a person would see the cursor there.
    const addGoal = async (number: number, text: string) => {
      await context.getByRole("button", { name: "Přidat cíl" }).click();
      await expect(context.getByRole("textbox", { name: `Hlavní cíle ${number}` })).toBeFocused();
      await page.keyboard.type(text);
    };
    await addGoal(1, "První cíl");
    await page.keyboard.press("Enter");
    await expect(context.getByRole("textbox", { name: "Hlavní cíle 2" })).toBeFocused();
    await page.keyboard.type("Druhý cíl");
    await context.getByRole("textbox", { name: "Hotovo, když" }).fill("Kampaň běží");
    await context.getByRole("textbox", { name: "Hotovo, když" }).press("Tab");
    await expect(context.getByRole("status")).toHaveText(/Uloženo|Ukládání…/);
    await expect(context.getByRole("status")).toHaveText("Uloženo");
    await expectOnServer(page, (row) => row.id === id.bare && JSON.stringify((row.properties?.context as { goals?: string[] })?.goals) === JSON.stringify(["První cíl", "Druhý cíl"]), true);
    const stored = await page.evaluate(async (projectId) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      return snapshot.entities.find((row: { id: string }) => row.id === projectId).properties;
    }, id.bare);
    expect(stored.context).toMatchObject({ why: "Bez toho nejde kampaň. Druhá věta.", doneWhen: "Kampaň běží", provenance: "owner" });
    expect(typeof stored.context.updatedAt).toBe("number");
    expect(stored.goal).toBe("Kampaň běží");
    // At most five goals; a goal can be removed.
    await addGoal(3, "Třetí");
    await addGoal(4, "Čtvrtý");
    await addGoal(5, "Pátý");
    await expect(context.getByRole("button", { name: "Přidat cíl" })).toHaveCount(0);
    await context.getByRole("button", { name: "Odebrat cíl 1" }).click();
    await expect(context.getByRole("button", { name: "Přidat cíl" })).toBeVisible();
    await expectOnServer(page, (row) => row.id === id.bare && (row.properties?.context as { goals?: string[] })?.goals?.length === 4, true);
    // The list shows the first sentence now.
    await page.locator(".projectBack").click();
    await expect(page.locator(".taskRow", { hasText: `Projekt B1${R} bez kontextu` }).locator("[data-project-why]")).toHaveText("Bez toho nejde kampaň.");
  } finally {
    await cleanup(page, Object.values(id));
  }
});

test("an old project's goal is shown as 'Hotovo, když' and nothing is lost when only the why is added", async ({ page }) => {
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const id = await seedWorld(page, stamp);
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: `Projekt B1${R} starý cíl` }).getByRole("button", { name: `Projekt B1${R} starý cíl`, exact: true }).click();
    const done = page.locator(".projectContext").getByRole("textbox", { name: "Hotovo, když" });
    await expect(done).toHaveValue("Starý cíl projektu zůstane vidět");
    await page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" }).fill("Protože ano");
    await page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" }).press("Tab");
    await expectOnServer(page, (row) => row.id === id.old && (row.properties?.context as { doneWhen?: string })?.doneWhen === "Starý cíl projektu zůstane vidět"
      && row.properties?.goal === "Starý cíl projektu zůstane vidět", true);
  } finally {
    await cleanup(page, Object.values(id));
  }
});

test("an old goal over 300 characters is shown in full and not saved until shortened", async ({ page }) => {
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const long = "Dlouhý cíl ".repeat(50);
  const id = `e2e-b1-longgoal-${stamp}`;
  expect(await seed(page, { entities: [entity(id, "project", `Projekt B1${R} dlouhý cíl`, { goal: long })] })).toBe(200);
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: `Projekt B1${R} dlouhý cíl` }).getByRole("button", { name: `Projekt B1${R} dlouhý cíl`, exact: true }).click();
    const done = page.locator(".projectContext").getByRole("textbox", { name: "Hotovo, když" });
    await expect(done).toHaveValue(long);
    await page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" }).fill("Důvod");
    await page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" }).press("Tab");
    await expect(page.getByText("Zkraťte na 300 znaků")).toBeVisible();
    await expectOnServer(page, (row) => row.id === id && row.properties?.goal === long && row.properties?.context === undefined, true);
    await done.fill("Krátký cíl");
    await done.press("Tab");
    await expectOnServer(page, (row) => row.id === id && (row.properties?.context as { doneWhen?: string } | undefined)?.doneWhen === "Krátký cíl" && row.properties?.goal === "Krátký cíl", true);
  } finally {
    await cleanup(page, [id]);
  }
});

test("the server refuses a context over its limits", async ({ page }) => {
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const project = entity(`e2e-b1-long-${stamp}`, "project", `Projekt B1${R} příliš dlouhý`, {
    context: { why: "x".repeat(601), goals: [], doneWhen: "", provenance: "owner", updatedAt: stamp } });
  expect(await seed(page, { entities: [project] })).toBe(400);
  const tooMany = entity(`e2e-b1-many-${stamp}`, "project", `Projekt B1${R} moc cílů`, {
    context: { why: "", goals: ["1", "2", "3", "4", "5", "6"], doneWhen: "", provenance: "owner", updatedAt: stamp } });
  expect(await seed(page, { entities: [tooMany] })).toBe(400);
});

test("phone 390px: the project page and the list fit the screen, with 44px touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  const stamp = now();
  const id = await seedWorld(page, stamp);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await fits()).toBe(true);
    await page.locator(".taskRow", { hasText: `Projekt B1${R} s kontextem` }).getByRole("button", { name: `Projekt B1${R} s kontextem`, exact: true }).click();
    await expect(page.locator(".projectPage")).toBeVisible();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    expect(await fits()).toBe(true);
    for (const locator of [page.locator(".projectBack"), page.locator(".projectGoalRemove").first(), page.locator(".projectGoalAdd"),
      page.locator(".projectPage .projectActions button").first(), page.locator(".projectAdd").first(), page.locator(".projectDetails summary"),
      page.locator(".projectTaskList .check").first()]) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      expect(box, String(locator)).not.toBeNull();
      expect(box!.height, String(locator)).toBeGreaterThanOrEqual(43.5);
    }
    await page.locator(".projectDetails summary").click();
    expect(await fits()).toBe(true);
    // A task opens the full-screen inspector; closing it returns to the page.
    await page.locator(".projectTaskList .taskRow").first().locator(".taskRowOpen").click();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await page.getByRole("button", { name: "← Zpět" }).click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".projectPage")).toBeVisible();
  } finally {
    await cleanup(page, Object.values(id));
  }
});

async function device(browser: Browser) {
  const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  return { context, page: await context.newPage() };
}

test("a context changed on another device while this one is being typed in is never overwritten silently", async ({ browser }) => {
  const a = await device(browser), b = await device(browser);
  await a.page.goto("/?view=Projects");
  await waitUntilSynced(a.page);
  const id = await seedWorld(a.page, now());
  const title = `Projekt B1${R} s kontextem`;
  const open = async (page: Page) => {
    await page.goto("/?view=Projects");
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: title }).getByRole("button", { name: title, exact: true }).click();
    await expect(page.locator(".projectPage")).toBeVisible();
  };
  const whyOnServer = (page: Page, why: string) =>
    expectOnServer(page, (row) => row.id === id.rich && (row.properties?.context as { why?: string })?.why === why, true);
  try {
    await open(a.page);
    await open(b.page);
    const whyA = a.page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" });
    // A types and does not leave the field.
    await whyA.click();
    await whyA.fill("Proč podle A");
    // B saves a different why.
    const whyB = b.page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" });
    await whyB.fill("Proč podle B");
    await whyB.press("Tab");
    await whyOnServer(b.page, "Proč podle B");
    // A takes B's change in while still typing: its draft stays and the conflict is shown with B's text.
    await a.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitUntilSynced(a.page);
    const conflict = a.page.locator(".projectContextConflict");
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(conflict).toContainText("Proč podle B");
    await expect(whyA).toHaveValue("Proč podle A");
    // Leaving the field writes nothing until the owner chooses: B's text is still the stored one.
    await whyA.press("Tab");
    await whyOnServer(a.page, "Proč podle B");
    // The local draft must survive both project navigation and a full browser reload.
    await a.page.locator(".projectBack").click();
    await expect(a.page.locator(".projectPage")).toHaveCount(0);
    await a.page.reload();
    await waitUntilSynced(a.page);
    await a.page.locator(".taskRow", { hasText: title }).getByRole("button", { name: title, exact: true }).click();
    const restored = a.page.locator(".projectContextConflict");
    await expect(restored).toBeVisible();
    await expect(a.page.locator(".projectContext").getByRole("textbox", { name: "Proč je důležitý" })).toHaveValue("Proč podle A");
    await expect(restored).toContainText("Proč podle B");
    await whyOnServer(a.page, "Proč podle B");
    // An explicit choice keeps A's draft, and the resolved draft is removed.
    await restored.getByRole("button", { name: "Přepsat aktuální verzi mým zněním" }).click();
    await expect(restored).toHaveCount(0);
    await whyOnServer(a.page, "Proč podle A");
    await expect(a.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("ai-executive-project-context-drafts:")))).resolves.toHaveLength(0);
  } finally {
    await cleanup(a.page, Object.values(id));
    await a.context.close();
    await b.context.close();
  }
});
