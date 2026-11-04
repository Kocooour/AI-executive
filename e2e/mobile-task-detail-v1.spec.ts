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
