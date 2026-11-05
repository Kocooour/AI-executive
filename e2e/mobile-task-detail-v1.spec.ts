import { expect, test } from "./fixtures";
import { expectOnServer, removeTasks, seedTasks, waitUntilSynced } from "./helpers";

test("opted-in phone task detail uses one square checkbox, preserves legacy desktop action and saves completion", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Lumi v1 preview disabled");
  const stamp = Date.now().toString(36);
  const id = `ui06a-task-${stamp}`, title = `Zařídit dopravu UI06a ${stamp}`;
  const when = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const deadline = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await seedTasks(page, [{ id, title, properties: { when, deadline } }]);
  try {
    await page.reload(); await waitUntilSynced(page);
    const row = page.locator(".taskRow", { hasText: title }).first();
    await row.getByRole("button", { name: title, exact: true }).click();
    const detail = page.locator("aside.inspectorDetail");
    await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(detail).toHaveAttribute("data-task-due-tone", "dueOverdue");
    const checkbox = detail.getByRole("checkbox", { name: `Dokončit: ${title}` });
    await expect(checkbox).toHaveAttribute("aria-checked", "false");
    await expect(checkbox).toHaveAttribute("aria-label", /Po termínu/);
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).toHaveCSS("width", "44px");
    await expect(detail.locator(".taskPreviewCheck")).toHaveCount(1);
    await expect(detail.locator(".fields .primaryAction")).toHaveCount(0);
    await expect(detail.locator("[data-task-preview-facts]")).toContainText(when);
    await expect(detail.locator("[data-task-preview-facts]")).toContainText(deadline);
    await expect(detail.locator(".taskPreviewCheck")).toHaveCSS("height", "44px");

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(detail).not.toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(detail.locator(".taskPreviewCheck")).toHaveCount(0);
    await expect(detail.locator(".fields .primaryAction")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await checkbox.click();
    await expectOnServer(page, (task) => task.id === id && (task as { status?: string }).status === "completed", true);
    await expect(detail).toHaveCount(0);
  } finally {
    await removeTasks(page, [id]);
  }
});

test("focused title draft survives mobile/desktop resize in both directions and persists after Back", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Lumi v1 preview disabled");
  const stamp = Date.now().toString(36);
  const id = `ui06a-resize-${stamp}`;
  const original = `Přejmenovat UI06a ${stamp}`;
  const when = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await seedTasks(page, [{ id, title: original, properties: { when } }]);
  try {
    await page.reload();
    await waitUntilSynced(page);
    const detail = page.locator("aside.inspectorDetail");
    let currentTitle = original;
    // First rotate mobile -> desktop, then desktop -> mobile. Neither
    // transition may unmount the focused title input before its blur/save.
    for (const [index, width] of [1280, 390].entries()) {
      await page.locator(".taskRow", { hasText: currentTitle }).first()
        .getByRole("button", { name: currentTitle, exact: true }).click();
      const titleInput = detail.locator("input.titleEdit");
      const nextTitle = `${original} verze ${index + 1}`;
      await titleInput.fill(nextTitle);
      await expect(titleInput).toBeFocused();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 390) {
        await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
      } else {
        await expect(detail).not.toHaveAttribute("data-task-detail-preview", "lumi-v1");
      }
      await expect(titleInput).toBeFocused();
      await expect(titleInput).toHaveValue(nextTitle);
      // No explicit input blur or refocus after the responsive transition:
      // Back must trigger the existing onBlur persistence path.
      await detail.locator(".inspectorClose").click();
      await expect(detail).toHaveCount(0);
      await expectOnServer(page, (task) => task.id === id && task.title === nextTitle, true);
      // Reopening after a reload proves this was a server write, not only
      // an in-memory selected title in the previous inspector instance.
      await page.reload();
      await waitUntilSynced(page);
      currentTitle = nextTitle;
    }
    await page.locator(".taskRow", { hasText: currentTitle }).first()
      .getByRole("button", { name: currentTitle, exact: true }).click();
    await expect(detail.locator("input.titleEdit")).toHaveValue(currentTitle);
  } finally {
    await removeTasks(page, [id]);
  }
});

test("mobile task notes and checklist stay primary; one disclosure holds other controls", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Lumi v1 preview disabled");
  const stamp = Date.now().toString(36);
  const id = `ui06b-task-${stamp}`, title = `Připravit výlet UI06b ${stamp}`;
  const when = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const note = `Seznam věcí UI06b ${stamp}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await seedTasks(page, [{ id, title, properties: {
    when, priority: "high", notes: note, checklist: [{ id: "bag", title: "Zabalit batoh", done: false }],
  } }]);
  try {
    await page.reload();
    await waitUntilSynced(page);
    await page.locator(".taskRow", { hasText: title }).first().getByRole("button", { name: title, exact: true }).click();
    const detail = page.locator("aside.inspectorDetail");
    const fields = detail.locator(".taskDetailFields");
    const toggle = fields.locator(".taskDetailMoreToggle");
    await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(fields.locator(".taskDetailEssentials .scheduleField")).toBeVisible();
    await expect(fields.locator(".taskDetailNotes textarea")).toHaveValue(note);
    await expect(fields.locator(".taskDetailNotes .checklistItem")).toContainText("Zabalit batoh");
    await expect(fields.locator(".taskDetailMoreList")).toBeHidden();
    await expect(fields.locator(".taskDetailMoreOptions")).toBeHidden();
    await expect(fields.locator(".taskDetailMoreActions")).toBeHidden();
    // The only disclosure reveals the unchanged legacy controls.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const priority = fields.locator(".taskDetailMoreOptions select").first();
    await expect(priority).toHaveValue("high");
    await expect(fields.locator(".taskDetailMoreList")).toBeVisible();
    await expect(fields.locator(".taskDetailMoreActions")).toBeVisible();
    await priority.focus();
    await expect(priority).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(detail).not.toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(toggle).toBeHidden();
    await expect(priority).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(priority).toBeFocused();
  } finally {
    await removeTasks(page, [id]);
  }
});

test("keyboard tab follows the actual task disclosure DOM order across responsive resize", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Lumi v1 preview disabled");
  const stamp = Date.now().toString(36);
  const id = `ui06b-keyboard-${stamp}`;
  const title = `Ovládání klávesnicí UI06b ${stamp}`;
  const when = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Upcoming");
  await waitUntilSynced(page);
  await seedTasks(page, [{ id, title, properties: { when, priority: "high" } }]);
  try {
    await page.reload();
    await waitUntilSynced(page);
    // Activate the task with the keyboard and traverse its actual tab stops.
    await page.locator(".taskRow", { hasText: title }).first()
      .getByRole("button", { name: title, exact: true }).press("Enter");
    const detail = page.locator("aside.inspectorDetail");
    const fields = detail.locator(".taskDetailFields");
    const toggle = fields.locator(".taskDetailMoreToggle");
    await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const list = fields.locator(".taskDetailMoreList select");
    const priority = fields.locator(".taskDetailMoreOptions select").first();
    // No .focus() or pointer clicks: this must be the browser's native Tab order.
    let onToggle = false;
    for (let step = 0; step < 40; step++) {
      if (await toggle.evaluate((node) => document.activeElement === node)) {
        onToggle = true;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(onToggle).toBe(true);
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(list).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(priority).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(list).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(priority).toBeFocused();
    // The same keyed select must survive React moving groups into desktop order.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(detail).not.toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(toggle).toBeHidden();
    await expect(priority).toBeFocused();
    await expect(list).toBeVisible();
    // Desktop's legacy order (list, planning, options, notes) is retained.
    const order = await fields.locator(":scope > div").evaluateAll((nodes) =>
      nodes.map((node) => node.classList.contains("taskDetailMoreList") ? "list"
        : node.classList.contains("taskDetailEssentials") ? "essentials"
          : node.classList.contains("taskDetailMoreOptions") ? "options"
            : node.classList.contains("taskDetailNotes") ? "notes" : "actions"));
    expect(order).toEqual(["list", "essentials", "options", "notes", "actions"]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toHaveAttribute("data-task-detail-preview", "lumi-v1");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(priority).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(list).toBeFocused();
  } finally {
    await removeTasks(page, [id]);
  }
});
