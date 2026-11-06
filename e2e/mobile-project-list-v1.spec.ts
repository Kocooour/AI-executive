import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";
import type { Page } from "@playwright/test";

// UI-05a intentionally uses the existing legacy project store. This visual
// preview must not imply that target R3 project ACL is active.
const stamp = () => Date.now().toString(36);
const entity = (id: string, type: string, title: string, status: string, properties: Record<string, unknown> = {}) => {
  const now = Date.now();
  return { id, type, title, status, workspaceId: "personal", properties, createdAt: now, updatedAt: now };
};
async function seedPreview(page: Page, ids: Record<string, string>) {
  const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  const entities = [
    entity(ids.area, "area", "Rodina", "active", { kind: "private" }),
    entity(ids.overdue, "project", "Naplánovat rodinnou akci s velmi dlouhým názvem pro mobil", "active"),
    entity(ids.finished, "project", "Hotový rodinný projekt", "completed"),
    entity(ids.empty, "project", "Projekt bez kroků", "active"),
    entity(ids.task, "task", "Otevřený úkol po termínu", "open", { deadline: past }),
  ];
  const now = Date.now();
  const relations = [
    ...[ids.overdue, ids.finished, ids.empty].map((projectId, i) => ({
      id: `ui05a-area-${i}-${now}`, sourceEntityId: projectId, targetEntityId: ids.area,
      relationType: "belongs_to_area", workspaceId: "personal", createdAt: now,
    })),
    { id: `ui05a-task-${now}`, sourceEntityId: ids.task, targetEntityId: ids.overdue,
      relationType: "belongs_to_project", workspaceId: "personal", createdAt: now },
  ];
  await expect.poll(() => page.evaluate(async ({ entities, relations }) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((res) => res.json());
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities, ...entities], relations: [...snapshot.relations, ...relations],
        deletedIds: [], revivedIds: [] }) });
    return response.status;
  }, { entities, relations }), { timeout: 15_000 }).toBe(200);
}
async function cleanPreview(page: Page, ids: Record<string, string>) {
  await expect.poll(() => page.evaluate(async (gone) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((res) => res.json());
    const remove = new Set(gone);
    const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: snapshot.entities.filter((row: { id: string }) => !remove.has(row.id)),
        relations: snapshot.relations.filter((r: { sourceEntityId: string; targetEntityId: string }) =>
          !remove.has(r.sourceEntityId) && !remove.has(r.targetEntityId)),
        deletedIds: gone, revivedIds: [] }) });
    return response.status;
  }, Object.values(ids)), { timeout: 15_000 }).toBe(200);
}

test("phone project list has accessible pastel Areas, one issue, circular statuses and safe completion", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview disabled");
  const id = stamp();
  const ids = { area: `ui05a-area-${id}`, overdue: `ui05a-overdue-${id}`,
    finished: `ui05a-finished-${id}`, empty: `ui05a-empty-${id}`, task: `ui05a-task-${id}` };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await seedPreview(page, ids);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const list = page.locator('.projectGroups[data-projects-preview="lumi-v1"]');
    await expect(list).toBeVisible();
    const group = page.locator(`[data-project-group="${ids.area}"]`);
    await expect(group).toHaveAttribute("data-preview-area-tone", "family");
    await expect(group).toHaveAttribute("aria-labelledby", `project-group-area:${ids.area}`);
    await expect(group.locator("h2.projectGroupHeading")).toHaveText("Rodina");
    await expect(group.locator("h2.projectGroupHeading")).toHaveCSS("clip-path", "inset(50%)");
    const urgent = group.locator(`[data-project-preview-row="${ids.overdue}"]`);
    await expect(urgent).toHaveAttribute("data-project-tone", "danger");
    await expect(urgent.locator("[data-project-summary]")).toHaveText("Po termínu");
    await expect(urgent.locator(".projectRowWhy, .projectRowNext, .taskRowMeta")).toHaveCount(0);
    await expect(urgent.locator(".v1ProjectCircle")).toHaveText("");
    await expect(urgent.locator(".v1ProjectCircle")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(urgent.locator(".v1ProjectCircle")).toHaveCSS("border-top-color", "rgb(185, 28, 28)");
    await expect(urgent.locator(".v1ProjectName")).toHaveCSS("font-weight", "650");
    const completed = group.locator(`[data-project-preview-row="${ids.finished}"]`);
    await expect(completed).toHaveAttribute("data-project-tone", "complete");
    await expect(completed.locator(".v1ProjectCircle")).toHaveText("✓");
    await expect(completed.locator("[data-project-summary]")).toHaveCount(0);
    const empty = group.locator(`[data-project-preview-row="${ids.empty}"]`);
    await expect(empty).toHaveAttribute("data-project-tone", "warning");
    await expect(empty.locator("[data-project-summary]")).toHaveText("Chybí další krok");
    await expect(empty.locator(".v1ProjectCircle")).toHaveCSS("border-top-color", "rgb(180, 83, 9)");
    const circle = urgent.locator(`[data-project-status-control="${ids.overdue}"]`);
    expect((await circle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Drag handles are intentionally hidden until the user enters reorder mode.
    const drag = urgent.locator(".dragHandle");
    await expect(drag).toHaveCount(0);
    const reorderToggle = page.locator('[data-v1-reorder-toggle]');
    await expect(reorderToggle).toHaveAttribute("aria-pressed", "false");
    await reorderToggle.click();
    await expect(reorderToggle).toHaveAttribute("aria-pressed", "true");
    await expect(drag).toBeVisible();
    expect((await drag.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect((await drag.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await reorderToggle.click();
    await expect(drag).toHaveCount(0);
    await circle.click();
    const confirm = page.locator("dialog.confirmDialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("1 nedokončený úkol");
    await expect(confirm).toContainText("stav podřízených úkolů nezmění");
    await confirm.getByRole("button", { name: "Zrušit" }).click();
    await expect(urgent).toHaveAttribute("data-project-tone", "danger");
    await circle.click();
    await confirm.getByRole("button", { name: "Dokončit", exact: true }).click();
    await expect(urgent).toHaveAttribute("data-project-tone", "complete");
    await expect.poll(async () => page.evaluate(async ({ projectId, taskId }) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((r) => r.json());
      return [snapshot.entities.find((e: { id: string }) => e.id === projectId)?.status,
        snapshot.entities.find((e: { id: string }) => e.id === taskId)?.status];
    }, { projectId: ids.overdue, taskId: ids.task })).toEqual(["completed", "open"]);
    await urgent.locator(".v1ProjectName .taskRowOpen").click();
    await expect(page.locator(".projectPage")).toHaveAttribute("data-project-page", ids.overdue);
    await page.locator(".projectBack").click();
    await expect(urgent).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // UI-04b shares the same preview project row and completion circle on desktop.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.projectGroups[data-projects-preview="lumi-v1"]')).toBeVisible();
    await expect(group.locator(".projectGroupHeading")).toHaveCSS("clip-path", "inset(50%)");
    await expect(group.locator(`[data-project-preview-row="${ids.overdue}"]`)).toBeVisible();
    await expect(group.locator(`[data-project-status-control="${ids.overdue}"]`)).toBeVisible();
    await expect(group.locator(".taskRowMeta")).toHaveCount(0);
  } finally {
    await cleanPreview(page, ids);
  }
});

/** Inspect the real browser-computed colors, including CSS color-mix() output.
 * Unlike the token-only tests, this catches overrides from the live cascade. */
async function computedContrast(page: Page, foregroundSelector: string,
  foregroundProperty: "borderTopColor" | "backgroundColor" | "color",
  backgroundSelector: string): Promise<number> {
  return page.evaluate(({ foregroundSelector, foregroundProperty, backgroundSelector }) => {
    const foreground = document.querySelector(foregroundSelector);
    const background = document.querySelector(backgroundSelector);
    if (!foreground || !background) throw new Error("Missing rendered contrast target");
    const parse = (raw: string) => {
      const rgb = /^rgba?\(([^)]+)\)$/.exec(raw);
      if (rgb) return rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
      const srgb = /^color\(srgb ([^)]+)\)$/.exec(raw);
      if (srgb) return srgb[1].split(/[\s/]+/).filter(Boolean).slice(0, 3).map((x) => Number(x) * 255);
      throw new Error("Unexpected computed CSS color: " + raw);
    };
    const luminance = (raw: string) => {
      const channels = parse(raw);
      return channels.reduce((sum, channel, index) => {
        const v = channel / 255;
        const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index];
      }, 0);
    };
    const fg = luminance(getComputedStyle(foreground)[foregroundProperty]);
    const bg = luminance(getComputedStyle(background).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }, { foregroundSelector, foregroundProperty, backgroundSelector });
}

for (const theme of ["light", "dark"] as const) {
  test("real mobile v1 project and calendar contrast in " + theme + " theme", async ({ page }) => {
    test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "UI v1 preview disabled");
    await page.addInitScript((chosen) => localStorage.setItem("ai-executive-theme", chosen), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    const suffix = stamp();
    const ids = {
      area: "ui05a-contrast-area-" + suffix, overdue: "ui05a-contrast-overdue-" + suffix,
      finished: "ui05a-contrast-finished-" + suffix, empty: "ui05a-contrast-empty-" + suffix,
      task: "ui05a-contrast-task-" + suffix,
    };
    await page.goto("/?view=Projects");
    await waitUntilSynced(page);
    await seedPreview(page, ids);
    try {
      await page.reload();
      await waitUntilSynced(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator('.appShell')).toHaveAttribute("data-design-system", "lumi-v1");
      const groupSelector = '[data-project-group="' + ids.area + '"]';
      const group = page.locator(groupSelector);
      await expect(group).toBeVisible();
      const border = await computedContrast(page, groupSelector, "borderTopColor", groupSelector);
      expect(border, theme + ": rendered Area group border must reach 3:1").toBeGreaterThanOrEqual(3);
      for (const [projectId, label] of [
        [ids.overdue, "danger"], [ids.empty, "warning"], [ids.finished, "complete"],
      ]) {
        const row = group.locator('[data-project-preview-row="' + projectId + '"]');
        await expect(row).toHaveAttribute("data-project-tone", label);
        const shape = groupSelector + ' [data-project-preview-row="' + projectId + '"] .v1ProjectCircle';
        const statusBorder = await computedContrast(page, shape, "borderTopColor", groupSelector);
        expect(statusBorder, theme + ": " + label + " status outline").toBeGreaterThanOrEqual(3);
        if (label === "complete") {
          const check = await computedContrast(page, shape, "color", shape);
          expect(check, theme + ": completed checkmark").toBeGreaterThanOrEqual(4.5);
        }
      }
      // Validate a real selected day in the same theme, not a sampled token pair.
      await page.goto("/?view=Calendar");
      await waitUntilSynced(page);
      const bubble = '.mobileCalendarDateBubble[data-selected="true"]';
      await expect(page.locator(bubble)).toBeVisible();
      for (const sub of [".mobileCalendarWeekday", ".mobileCalendarDateNumber"]) {
        const textRatio = await computedContrast(page, bubble + " " + sub, "color", bubble);
        expect(textRatio, theme + ": calendar " + sub).toBeGreaterThanOrEqual(4.5);
      }
      // The same Area groups are now rendered on desktop; no headings are
      // visible, so their pastel surface and strong boundary must persist.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/?view=Projects");
      await waitUntilSynced(page);
      const desktopGroup = page.locator(groupSelector);
      await expect(desktopGroup).toBeVisible();
      await expect(page.locator('.projectGroups[data-projects-preview="lumi-v1"]')).toBeVisible();
      await expect(desktopGroup.locator(".projectGroupHeading")).toHaveCSS("clip-path", "inset(50%)");
      const desktopBorder = await computedContrast(page, groupSelector, "borderTopColor", groupSelector);
      expect(desktopBorder, theme + ": desktop Area group border").toBeGreaterThanOrEqual(3);
      await expect(desktopGroup).toHaveAttribute("data-preview-area-tone", "family");
      // Read *computed* background colors from the mounted group at desktop
      // width. Changing its tone attribute exposes CSS cascade regressions
      // without writing synthetic additional Areas to the persistent store.
      const desktopColors = await desktopGroup.evaluate((node) => {
        const originalTone = node.getAttribute("data-preview-area-tone");
        const tones = ["personal", "work", "family", "extra-a", "extra-b", "extra-c"];
        const colors: string[] = [];
        try {
          for (const tone of tones) {
            node.setAttribute("data-preview-area-tone", tone);
            colors.push(getComputedStyle(node).backgroundColor);
          }
        } finally {
          if (originalTone === null) node.removeAttribute("data-preview-area-tone");
          else node.setAttribute("data-preview-area-tone", originalTone);
        }
        return colors;
      });
      expect(new Set(desktopColors).size, theme + ": six desktop Area tones must render distinct colors").toBe(6);
      await expect(desktopGroup.locator('[data-project-preview-row="' + ids.overdue + '"] .v1ProjectCircle')).toBeVisible();
    } finally {
      await cleanPreview(page, ids);
    }
  });
}
