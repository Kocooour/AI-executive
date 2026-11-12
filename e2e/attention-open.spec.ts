import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { expectOnServer, removeTasks, seeded, serverEntities, waitUntilSynced } from "./helpers";

const pragueDate = (page: Page, days: number) => page.evaluate((offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" })
  .format(new Date(Date.now() + offset * 86_400_000)), days);

async function attentionItem(page: Page, title: string) {
  await page.goto("/");
  await waitUntilSynced(page);
  const more = page.locator(".attentionSection button.textAction", { hasText: "Zobrazit dalších" });
  if (await more.count()) await more.click();
  return page.locator(".attentionItem", { hasText: title });
}

// A task whose planned day has passed and is still open needs attention (owner decision
// 2026-10-09); planning it again ends that.
test("a task whose planned day has passed is shown as needing attention", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Prošlý den ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  try {
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const yesterday = await pragueDate(page, -1);
  await page.locator(".detail input[type=date][aria-label='Kdy']").fill(yesterday);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === yesterday, true);
  const item = await attentionItem(page, title);
  await expect(item).toContainText("Naplánovaný den včera uplynul a úkol není hotový");
  await expect(item.getByRole("button", { name: /^Proč\?:/ })).toBeVisible();
  // Planned for tomorrow, it no longer needs attention.
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const tomorrow = await pragueDate(page, 1);
  await page.locator(".detail input[type=date][aria-label='Kdy']").fill(tomorrow);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.when === tomorrow, true);
  await expect(await attentionItem(page, title)).toHaveCount(0);
  } finally {
    await removeTasks(page, [id]);
  }
});

// A local task edit can finish syncing before Attention's GET returns. The old
// evidence must never regain its date chip during that green-sync interval.
test("a synced task edit disables stale quick actions while Attention refresh is delayed", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Zastaralý podklad ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let taskId = "";
  await expect.poll(async () => (taskId = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  try {
  await page.goto(`/?task=${taskId}`);
  await waitUntilSynced(page);
  const yesterday = await pragueDate(page, -1);
  await page.locator(".detail input[type=date][aria-label='Kdy']").fill(yesterday);
  await expectOnServer(page, (entity) => entity.id === taskId && entity.properties?.when === yesterday, true);
  const item = await attentionItem(page, title);
  await expect(item.locator(".deferChip")).toBeVisible();

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let intercepted = 0;
  await page.route("**/api/attention?**", async (route) => {
    intercepted++;
    await held;
    // A superseded GET can be cancelled by the app while deliberately held.
    // That is not a route-handler failure; unexpected errors must still fail.
    try {
      await route.continue();
    } catch (error) {
      if (!(error instanceof Error) || !/Route is already handled|Target .*closed/i.test(error.message)) throw error;
    }
  });
  try {
    await item.locator(".attentionTitleButton").click();
    await expect(page.locator(".detail input[type=date][aria-label='Kdy']")).toBeVisible();
    const tomorrow = await pragueDate(page, 1);
    await page.locator(".detail input[type=date][aria-label='Kdy']").fill(tomorrow);
    await expectOnServer(page, (entity) => entity.id === taskId && entity.properties?.when === tomorrow, true);
    await expect.poll(() => page.evaluate(() => [localStorage.getItem("ai-executive-server-synced"), localStorage.getItem("ai-executive-pending-sync")]), { timeout: 20_000 }).toEqual(["1", null]);
    await page.getByRole("button", { name: "Zavřít", exact: true }).click();
    const refresh = page.getByRole("button", { name: "Obnovit" }).first();
    await expect(refresh).toBeEnabled(); // Sync is green, even though the Attention GET is held.
    await refresh.click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await expect(item.locator(".attentionRowStale")).toContainText("Neaktuální");
    await expect(item.locator(".deferChip")).toHaveCount(0);
    await expect(item.getByRole("button", { name: `Otevřít: ${title}` })).toBeVisible();
    await item.getByRole("button", { name: `Proč?: ${title}` }).click();
    await expect(item.locator(".attentionExplanationChanged")).toContainText("od vyhodnocení změnil");
    await expect(page.locator(".deferPopover")).toHaveCount(0);
  } finally {
    release();
    // Wait for a held handler before closing its route: otherwise a late
    // route.continue() can report "Route is already handled" during teardown.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
  // The delayed old request is not itself proof of a fresh evaluation.
  // Force an unblocked GET before asserting that yesterday's item is gone.
  await page.getByRole("button", { name: "Obnovit" }).first().click();
  await expect(item).toHaveCount(0);
  } finally {
    await removeTasks(page, [taskId]);
  }
});

// An Attention-origin date popover can already be open when the browser loses
// its last valid evaluation. It must not remain a way to act on old evidence.
test("a quick date dialog opened from Attention closes when its evaluation becomes stale", async ({ page }) => {
  const item = await attentionItem(page, seeded.overdueTask);
  const chip = item.locator(".deferChip");
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator(".deferPopover")).toBeVisible();

  // This is the same browser offline signal the Attention hook listens for.
  // No reload: the pre-existing popover has to be revoked in place.
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(item.locator(".attentionRowStale")).toBeVisible();
  await expect(page.locator(".deferPopover")).toHaveCount(0);
  await expect(page.locator(".deferChoice, .deferApply")).toHaveCount(0);
  await expect(chip).toHaveCount(0);
  await expect(item.getByRole("button", { name: `Otevřít: ${seeded.overdueTask}` })).toBeVisible();

  // Once a fresh evaluation is available, the old dialog must not reopen.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".attentionStale")).toHaveCount(0);
  await expect(page.locator(".deferPopover")).toHaveCount(0);
  await expect(item.locator(".deferChip")).toHaveAttribute("aria-expanded", "false");
});

// A successful server GET (sync stays green) can remove or replace the evidence
// behind a previously opened date chip. Neither case may leave a working modal.
for (const change of ["removed", "fingerprint-changed"] as const) {
  test(`a fresh Attention refresh with ${change} evidence revokes the open dialog and restores focus`, async ({ page }) => {
    const item = await attentionItem(page, seeded.overdueTask);
    const chip = item.locator(".deferChip");
    await expect(chip).toBeVisible();
    const taskId = await chip.getAttribute("data-defer-chip");
    expect(taskId).toBeTruthy();
    await chip.click();
    await expect(page.locator(".deferPopover")).toBeVisible();

    let found = false;
    let fulfilled = 0;
    await page.route("**/api/attention?**", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const matched = data.items.filter((candidate: { subjectId: string }) => candidate.subjectId === taskId);
      found = found || matched.length > 0;
      const items = change === "removed"
        ? data.items.filter((candidate: { subjectId: string }) => candidate.subjectId !== taskId)
        : data.items.map((candidate: { subjectId: string; sourceFingerprint: string }) =>
          candidate.subjectId === taskId
            ? { ...candidate, sourceFingerprint: `${candidate.sourceFingerprint}-changed` }
            : candidate);
      await route.fulfill({ response, json: { ...data, items } });
      fulfilled++;
    });
    try {
      await page.getByRole("button", { name: "Obnovit" }).first().click();
      // Zero popovers can be true *before* the intercepted response is sent.
      // Wait for the exact modified GET to finish before testing UI revocation.
      await expect.poll(() => fulfilled, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(found).toBe(true);
      await expect(page.locator(".deferPopover")).toHaveCount(0);
      await expect(page.locator(".deferChoice, .deferApply, .deferClear")).toHaveCount(0);
      await expect(page.locator("#attention-title")).toBeFocused();
      if (change === "removed") {
        await expect(page.locator(".attentionItem", { hasText: seeded.overdueTask })).toHaveCount(0);
      } else {
        await expect(page.locator(".attentionItem", { hasText: seeded.overdueTask })).toBeVisible();
        await expect(page.locator(".attentionItem", { hasText: seeded.overdueTask }).locator(".deferChip")).toHaveAttribute("aria-expanded", "false");
      }
      // Even another React render must not resurrect the old open dialog.
      await expect(page.locator(".deferPopover")).toHaveCount(0);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
}

// The last evaluation is kept in this browser: when the server cannot evaluate after a restart,
// Home shows it marked as out of date, and snooze and dismiss wait.
test("the last attention evaluation is shown out of date when the server cannot evaluate", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const first = page.locator(".attentionItem").first();
  await expect(first).toBeVisible();
  const title = (await first.locator("strong").textContent()) || "";
  // While the server is still evaluating, the copy from this browser is shown as such.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/attention**", async (route) => { await held; await route.continue(); });
  await page.reload();
  await expect(page.locator(".attentionStale")).toContainText("Uloženo v zařízení, ověřuji změny");
  release();
  await expect(page.locator(".attentionStale")).toHaveCount(0);
  await page.unroute("**/api/attention**");
  await page.route("**/api/attention**", (route) => route.abort());
  await page.reload();
  await waitUntilSynced(page);
  await expect(page.locator(".attentionStale")).toBeVisible();
  const cached = page.locator(".attentionItem", { hasText: title }).first();
  await expect(cached).toBeVisible();
  // The stale label must be on the recommendation as well as in the section header.
  await expect(cached.locator(".attentionRowStale")).toContainText("Neaktuální");
  await expect(cached.locator(".deferChip")).toHaveCount(0);
  await expect(cached.getByRole("button", { name: `Otevřít: ${title}` })).toBeVisible();
  await cached.getByRole("button", { name: `Proč?: ${title}` }).press("Enter");
  await expect(cached.locator(".attentionExplanationStale")).toContainText("staršího vyhodnocení");
  await page.locator(".attentionItem").first().getByRole("button", { name: /^Další akce/ }).click();
  await expect(page.locator(".attentionItem").first().getByRole("menuitem", { name: /^Skrýt/ })).toBeDisabled();
  await page.unroute("**/api/attention**");
  await page.getByRole("button", { name: "Obnovit" }).first().click();
  await expect(page.locator(".attentionStale")).toHaveCount(0);
});

// Started without any connection, the app shows this browser's data (owner decision 2026-10-09)
// and the last attention evaluation, marked as offline.
test("a start without connection shows the last attention evaluation marked as offline", async ({ page }) => {
  await page.goto("/");
  await waitUntilSynced(page);
  const first = page.locator(".attentionItem").first();
  await expect(first).toBeVisible();
  const title = (await first.locator("strong").textContent()) || "";
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".offlineStart")).toBeVisible();
  await expect(page.locator(".attentionStale")).toContainText("Jste offline");
  await expect(page.locator(".attentionItem", { hasText: title }).first()).toBeVisible();
  await expect(page.locator(".attentionItem", { hasText: title }).first().locator(".attentionRowStale")).toBeVisible();
  await page.unroute("**/api/**");
});
