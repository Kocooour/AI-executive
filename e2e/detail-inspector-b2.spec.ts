import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { expectOnServer, waitUntilSynced } from "./helpers";

// The full suite shares one synthetic server. Seeded records may have been archived by
// previous scenarios; create the specific active Inbox targets through the actual UI.
async function createInboxTasks(page: Page, count: number) {
  const original = page.viewportSize() || { width: 1440, height: 900 };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const names: string[] = [];
  const entry = page.locator(".capture input");
  await expect(entry).toBeVisible();
  for (let n = 0; n < count; n++) {
    const name = "B2 inspector fixture " + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    await entry.fill(name);
    await entry.press("Enter");
    await expect(page.locator(".taskRow", { hasText: name })).toBeVisible();
    await expect.poll(async () => {
      const response = await page.evaluate(async (title) => {
        const { entities } = await fetch("/api/store", { cache: "no-store" }).then((result) => result.json());
        return entities.find((entity: { title: string }) => entity.title === title);
      }, name);
      return { status: response?.status, inbox: response?.properties?.inbox };
    }, { timeout: 20_000 }).toEqual({ status: "open", inbox: true });
    names.push(name);
  }
  await page.setViewportSize(original);
  return names;
}

test.describe("B2 responsive detail inspector", () => {
  test("desktop keeps the working list usable beside the detail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [taskA] = await createInboxTasks(page, 1);
    await page.locator(".taskRow", { hasText: taskA }).first().click();
    await expect(page.locator(".appShell")).toHaveClass(/inspectorOpen/);
    await expect(page.locator(".appPane")).toBeVisible();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "sticky");
    await expect(page.getByRole("button", { name: "Zavřít", exact: true })).toBeVisible();
    await expect(page.locator(".taskRow", { hasText: taskA })).toBeVisible();
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
  });

  test("tablet presents a full content detail with a back action", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const [taskA] = await createInboxTasks(page, 1);
    await page.locator(".taskRow", { hasText: taskA }).first().click();
    await expect(page.locator(".appPane")).toBeHidden();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await expect(page.getByRole("button", { name: "← Zpět" })).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "relative");
    await page.locator(".inspectorClose").click();
    await expect(page.locator(".appPane")).toBeVisible();
  });

  test("iPhone shows a full-screen detail and returns to the list", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const [taskA] = await createInboxTasks(page, 1);
    await page.locator(".taskRow", { hasText: taskA }).first().click();
    await expect(page.locator("aside.inspectorDetail")).toBeVisible();
    await expect(page.getByRole("button", { name: "← Zpět" })).toBeVisible();
    await expect(page.locator(".inspectorBackdrop")).toHaveCSS("position", "fixed");
    const detail = await page.locator("aside.inspectorDetail").boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page.locator(".taskRow", { hasText: taskA })).toBeVisible();
  });

  test("a completing save does not replace a newer inspector selection", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [taskA, taskB] = await createInboxTasks(page, 2);
    await page.locator(".taskRow", { hasText: taskA }).first().click();
    const title = page.locator("aside.inspectorDetail .titleEdit");
    await title.fill(`${taskA} upraveno`);
    await page.locator(".taskRow", { hasText: taskB }).first().click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
    // Wait for A's blur save to finish; it must not reopen A over the selected B.
    await expectOnServer(page, (entity) => entity.title === `${taskA} upraveno`, true);
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
  });

  test("keyboard can enter the inspector and returns focus to the originating task", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [taskA] = await createInboxTasks(page, 1);
    const opener = page.locator(".taskRow", { hasText: taskA })
      .first().getByRole("button", { name: taskA, exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
    await page.getByRole("button", { name: "Zavřít", exact: true }).click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Space is also provided by the native button's keyboard activation.
    await page.keyboard.press("Space");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
  });

  test("rapid inspector switches keep the final selection and clear context on close", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [taskA, taskB] = await createInboxTasks(page, 2);
    await page.locator(".taskRow", { hasText: taskA }).first().click();
    await page.locator(".taskRow", { hasText: taskB }).first().click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await page.locator(".taskRow", { hasText: taskA }).first().click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskA);
  });


  test("Close dismisses B while Back and Forward retain record history", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [taskA, taskB] = await createInboxTasks(page, 2);
    const rowA = page.locator(".taskRow", { hasText: taskA }).first();
    const rowB = page.locator(".taskRow", { hasText: taskB }).first();

    await rowA.click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskA);
    const addressA = page.url();
    expect(addressA).toMatch(/[?]view=Inbox&taskId=/);

    await rowB.click();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
    const addressB = page.url();
    expect(addressB).toMatch(/[?]view=Inbox&taskId=/);
    expect(addressB).not.toBe(addressA);

    // Browser history traverses records; Close is not the same command.
    await page.goBack();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskA);
    await expect(page).toHaveURL(addressA);
    await page.goForward();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
    await expect(page).toHaveURL(addressB);

    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/[?]view=Inbox$/);
    // Close REPLACES B's entry; it does not push a list entry that would
    // reopen B on Back. The older A history entry remains accessible.
    await page.goBack();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskA);
    await expect(page).toHaveURL(addressA);
    await page.goForward();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/[?]view=Inbox$/);

    // A pasted/reloaded record address has no in-app opener, yet closes safely.
    await page.goto(addressB);
    await waitUntilSynced(page);
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/[?]view=Inbox$/);
  });

  test("Close keeps the reading scope of a typed record address", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [task] = await createInboxTasks(page, 1);
    const id = await page.locator(".taskRow", { hasText: task }).first().getAttribute("data-drop-entity");
    expect(id).toBeTruthy();

    // Scope is orthogonal to the typed record target. Closing may remove only
    // taskId, not reset personal/shared reading scope to the default "all".
    await page.goto(`/?view=Inbox&scope=personal&taskId=${encodeURIComponent(id!)}`);
    await waitUntilSynced(page);
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(task);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(page).toHaveURL(/[?]view=Inbox&scope=personal$/);
  });

  test("removing A during a delayed sync cannot close B's newer inspector", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const [taskA, taskB] = await createInboxTasks(page, 2);
    let releaseSync: (() => void) | undefined;
    let signalBlocked: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { signalBlocked = resolve; });
    await page.route("**/api/store", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await new Promise<void>((resolve) => { releaseSync = resolve; signalBlocked(); });
      await route.continue();
    });
    try {
      await page.locator(".taskRow", { hasText: taskA }).first().click();
      await page.locator("aside.inspectorDetail button.danger").last().click();
      await blocked;
      await page.locator(".taskRow", { hasText: taskB }).first().click();
      await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
      releaseSync?.();
      await expectOnServer(page, (entity) => entity.title === taskA, false);
      await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(taskB);
    } finally {
      releaseSync?.();
      await page.unrouteAll({ behavior: "wait" });
    }
  });


});
