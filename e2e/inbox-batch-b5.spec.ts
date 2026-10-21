import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { waitUntilSynced } from "./helpers";

// Real canonical server fixtures, with a second workspace to detect leaks.
async function seedInboxBatch(page: Page) {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const data = await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then(res => res.json());
    const now = Date.now();
    const token = `b5-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const other = `${token}-other`;
    const make = (id: string, type: string, title: string, workspaceId = "personal",
                  properties: Record<string, unknown> = {}) => ({
      id, type, title, workspaceId, properties, status: type === "task" ? "open" : "active",
      createdAt: now, updatedAt: now,
    });
    const one = make(`task:one:${token}`, "task", `B5 alfa ${token}`, "personal",
      { inbox: true, originalCaptureText: "Původní záznam alfa" });
    const two = make(`task:two:${token}`, "task", `B5 beta ${token}`, "personal",
      { inbox: true, originalCaptureText: "Původní záznam beta" });
    const project = make(`project:${token}`, "project", `B5 projekt ${token}`);
    const area = make(`area:${token}`, "area", `B5 oblast ${token}`);
    const hidden = make(`hidden:${token}`, "task", `B5 tajné ${token}`, other, { inbox: true });
    const workspace = make(`workspace:${other}`, "workspace", "B5 jiný prostor", other,
      { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] });
    const result = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities, one, two, project, area, hidden, workspace],
        relations: snapshot.relations, deletedIds: [], revivedIds: [],
      }),
    });
    if (!result.ok) throw new Error(`B5 seed error: ${result.status}`);
    return { one: one.title, oneId: one.id, two: two.title, twoId: two.id,
      project: project.title, projectId: project.id, area: area.title, areaId: area.id,
      hidden: hidden.title, hiddenId: hidden.id };
  });
  await page.reload();
  await waitUntilSynced(page);
  return data;
}

for (const width of [390, 1280]) {
  test(`B5 reviews and atomically files two Inbox tasks in one workspace at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const data = await seedInboxBatch(page);
    const panel = page.getByRole("region", { name: "Hromadné třídění" });
    await expect(panel).toBeVisible();
    const first = page.getByRole("checkbox", { name: `Vybrat: ${data.one}` });
    const second = page.getByRole("checkbox", { name: `Vybrat: ${data.two}` });
    await expect(first).toBeEnabled();
    await first.check();
    await second.check();
    await expect(panel).toContainText("Vybráno: 2");
    await expect(page.getByRole("checkbox", { name: `Vybrat: ${data.hidden}` })).toHaveCount(0);
    await panel.getByLabel("Hromadná akce").selectOption("organize");
    await panel.getByLabel("Do projektu").selectOption(data.projectId);
    await panel.getByLabel("Do oblasti").selectOption(data.areaId);
    await panel.getByRole("button", { name: "Zkontrolovat změny" }).click();
    const review = panel.getByRole("group", { name: "Kontrola před uložením" });
    await expect(review).toContainText(data.one);
    await expect(review).toContainText(data.two);
    await expect(review).toContainText(data.project);
    await expect(review).toContainText(data.area);
    await expect(review.locator("li")).toHaveCount(2);
    await review.getByRole("button", { name: "Potvrdit všechny změny" }).click();
    await expect.poll(async () => page.evaluate(async ({ oneId, twoId, projectId, areaId, hiddenId }) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then(res => res.json());
      const rows = [oneId, twoId].map(id => snapshot.entities.find((e: { id: string }) => e.id === id));
      const has = (id: string, target: string, type: string) => snapshot.relations
        .some((r: { sourceEntityId: string; targetEntityId: string; relationType: string; workspaceId: string }) =>
          r.sourceEntityId === id && r.targetEntityId === target && r.relationType === type && r.workspaceId === "personal");
      return {
        inbox: rows.map(e => e?.properties?.inbox),
        project: [oneId, twoId].map(id => has(id, projectId, "belongs_to_project")),
        area: [oneId, twoId].map(id => has(id, areaId, "belongs_to_area")),
        other: snapshot.entities.find((e: { id: string }) => e.id === hiddenId)?.properties?.inbox,
      };
    }, data), { timeout: 20000 }).toEqual({
      inbox: [false, false], project: [true, true], area: [true, true], other: true,
    });
    if (width === 390) {
      const hit = await first.locator("..").evaluate(el => el.getBoundingClientRect().height);
      expect(hit).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });
}

test("B5 rejects a stale task without partially moving any selected item", async ({ page }) => {
  const data = await seedInboxBatch(page);
  await page.getByRole("checkbox", { name: `Vybrat: ${data.one}` }).check();
  await page.getByRole("checkbox", { name: `Vybrat: ${data.two}` }).check();
  const panel = page.getByRole("region", { name: "Hromadné třídění" });
  await panel.getByRole("button", { name: "Zkontrolovat změny" }).click();
  await expect(panel.getByRole("group", { name: "Kontrola před uložením" })).toBeVisible();
  // Simulate a different tab updating the same IndexedDB store after the review
  // snapshot, without repainting this tab's React list. No server write here.
  await page.evaluate(async id => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("ai-executive");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("entities", "readwrite");
        const read = tx.objectStore("entities").get(id);
        read.onsuccess = () => {
          const row = read.result;
          tx.objectStore("entities").put({ ...row, updatedAt: row.updatedAt + 1000 });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, data.oneId);
  await panel.getByRole("button", { name: "Potvrdit všechny změny" }).click();
  await expect(panel.getByRole("alert")).toContainText("Hromadná změna nebyla provedena");
  await expect.poll(async () => page.evaluate(async ({ oneId, twoId }) => {
    const data = await fetch("/api/store", { cache: "no-store" }).then(r => r.json());
    return [oneId, twoId].map(id => data.entities.find((e: { id: string }) => e.id === id)?.properties?.inbox);
  }, data)).toEqual([true, true]);
});

test("B5 aggregate workspace stays read-only and exposes no selection controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await seedInboxBatch(page);
  await page.locator(".mobileWorkspaceButton").click();
  await page.locator('.mobileWorkspaceMenu [data-workspace-id="all"]').click();
  await expect(page.getByText("Souhrn Vše je pouze ke čtení.", { exact: false })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Vybrat: ${data.one}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Potvrdit všechny změny" })).toHaveCount(0);
});
