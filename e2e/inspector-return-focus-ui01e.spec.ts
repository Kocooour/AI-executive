import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";

// UI-01e browser regression: real React selection, browser history and DOM focus.
// Runs in the isolated pre-release browser gate, not on every PR.
async function createInboxPair(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const names = [`UI01e focus A ${suffix}`, `UI01e focus B ${suffix}`];
  const input = page.locator(".capture input");
  await expect(input).toBeVisible();
  for (const title of names) {
    await input.fill(title);
    await input.press("Enter");
    await expect(page.locator(".taskRow[data-entity-type='task']", { hasText: title })).toBeVisible();
    await expect.poll(async () => page.evaluate(async (name) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      return snapshot.entities.some((row: { title: string; status: string }) =>
        row.title === name && row.status === "open");
    }, title)).toBe(true);
  }
  return names;
}

async function removeInboxPair(page: Page, names: string[]) {
  const status = await page.evaluate(async (titles) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const ids = new Set(snapshot.entities.filter((row: { title: string }) => titles.includes(row.title))
      .map((row: { id: string }) => row.id));
    const response = await fetch("/api/store", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: snapshot.entities.filter((row: { id: string }) => !ids.has(row.id)),
        relations: snapshot.relations.filter((relation: { sourceEntityId: string; targetEntityId: string }) =>
          !ids.has(relation.sourceEntityId) && !ids.has(relation.targetEntityId)),
        deletedIds: [...ids], revivedIds: [],
      }),
    });
    return response.status;
  }, names);
  expect(status).toBe(200);
}

test("UI-01e: keyboard A → close A → background-select B → close B does not restore stale A", async ({ page }) => {
  const names = await createInboxPair(page);
  try {
    const [nameA, nameB] = names;
    const rowA = page.locator(".taskRow[data-entity-type='task']", { hasText: nameA });
    const rowB = page.locator(".taskRow[data-entity-type='task']", { hasText: nameB });
    const openerA = rowA.locator(".taskRowOpen");
    await openerA.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(nameA);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(openerA).toBeFocused();

    // Click the non-focusable row padding, not B's title button: A is the
    // last keyboard opener, which used to be incorrectly retained for B.
    const box = await rowB.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 2, box!.y + box!.height / 2);
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(nameB);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(openerA).not.toBeFocused();
  } finally {
    await removeInboxPair(page, names);
  }
});

test("UI-01e: keyboard opener is restored once and direct link cannot borrow its focus", async ({ page }) => {
  const names = await createInboxPair(page);
  try {
    const [nameA, nameB] = names;
    const openerA = page.locator(".taskRow[data-entity-type='task']", { hasText: nameA }).locator(".taskRowOpen");
    await openerA.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
    await page.locator(".inspectorClose").click();
    await expect(openerA).toBeFocused();
    // A direct link remounts the page with no keyboard origin in this tab.
    const rowB = page.locator(".taskRow[data-entity-type='task']", { hasText: nameB });
    const taskBId = await rowB.getAttribute("data-drop-entity");
    expect(taskBId).toBeTruthy();
    await page.goto(`/?view=Inbox&taskId=${taskBId}`);
    await waitUntilSynced(page);
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(nameB);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    // The previous DOM opener was replaced by navigation and must not be focused.
    await expect(page.locator(".taskRow[data-entity-type='task']", { hasText: nameA })
      .locator(".taskRowOpen")).not.toBeFocused();
  } finally {
    await removeInboxPair(page, names);
  }
});

test("UI-01e: switching A directly to B without closing A cannot steal B's return focus", async ({ page }) => {
  const names = await createInboxPair(page);
  try {
    const [nameA, nameB] = names;
    const openerA = page.locator(".taskRow[data-entity-type='task']", { hasText: nameA }).locator(".taskRowOpen");
    const rowB = page.locator(".taskRow[data-entity-type='task']", { hasText: nameB });
    const openerB = rowB.locator(".taskRowOpen");

    // A is open and owns a keyboard-origin focus; B is selected directly
    // from the non-focusable row, without closing A first.
    await openerA.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
    await rowB.click({ position: { x: 2, y: 2 } });
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(nameB);
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(openerA).not.toBeFocused();

    // When B itself is opened by keyboard while A remains inspected,
    // only B's opener may receive focus after Back/close.
    await openerA.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(nameA);
    await openerB.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("aside.inspectorDetail .titleEdit")).toHaveValue(nameB);
    await expect(page.locator("aside.inspectorDetail")).toBeFocused();
    await page.locator(".inspectorClose").click();
    await expect(page.locator("aside.inspectorDetail")).toHaveCount(0);
    await expect(openerB).toBeFocused();
    await expect(openerA).not.toBeFocused();
  } finally {
    await removeInboxPair(page, names);
  }
});
