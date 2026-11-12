import { expect, test } from "./fixtures";
import { expectOnServer, serverEntities, waitUntilSynced } from "./helpers";

// A task marked as waiting for someone comes back among the items that need attention on its
// follow-up date, with the reason; it ends when the waiting is ended.
test("a task waiting for someone comes back on its follow-up date", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Čeká na Petra ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const waiting = page.locator(".waitingField");
  const toggle = waiting.getByLabel("Čeká na odpověď nebo na někoho jiného");
  await toggle.click();
  await expect(toggle).toBeChecked();
  await waiting.getByLabel("Čeká na", { exact: true }).fill("Petr");
  await waiting.getByLabel("Připomenout").focus();
  const today = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date()));
  await waiting.getByLabel("Připomenout").fill(today);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waiting === true && entity.properties?.inbox === false && entity.properties?.waitingFor === "Petr" && entity.properties?.followUpDate === today, true);
  // A waiting task is sorted: it leaves the Inbox.
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await expect(page.locator("article", { hasText: title })).toHaveCount(0);
  await page.goto("/?view=Anytime");
  await expect(page.locator("article", { hasText: title }).locator('.taskRowMeta[data-meta-kind="state"]')).toHaveText("Čeká");
  // Changing who it waits for and closing the detail at once does not open the task again when
  // the change is saved.
  await page.locator("article", { hasText: title }).click();
  await expect(page.locator(".waitingField").getByLabel("Čeká na", { exact: true })).toHaveValue("Petr");
  await page.locator(".waitingField").getByLabel("Čeká na", { exact: true }).fill("Petra Nová");
  await page.locator(".detail button.close").click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waitingFor === "Petra Nová", true);
  await page.waitForTimeout(300);
  await expect(page.locator(".detail")).toHaveCount(0);
  await page.goto("/");
  await waitUntilSynced(page);
  const item = page.locator(".attentionItem", { hasText: title });
  await expect(item).toContainText("Nastal den připomenutí");
  await expect(item).toContainText("čeká na: Petra Nová");
  // #242: the detailed rule reason is now in Proč?, not the collapsed row.
  await item.getByRole("button", { name: `Proč?: ${title}` }).click();
  await expect(item.locator(".attentionMore")).toContainText("označeno jako čekající");
  // Ending the waiting ends the item.
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const off = page.locator(".waitingField").getByLabel("Čeká na odpověď nebo na někoho jiného");
  await off.click();
  await expect(off).not.toBeChecked();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waiting === false, true);
  await page.goto("/");
  await waitUntilSynced(page);
  await expect(page.locator(".attentionItem", { hasText: title })).toHaveCount(0);
  // Marking it as waiting and closing the detail at once does not open the task again either.
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  await page.locator(".waitingField").getByLabel("Čeká na odpověď nebo na někoho jiného").click();
  await page.locator(".detail button.close").click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waiting === true, true);
  await page.waitForTimeout(300);
  await expect(page.locator(".detail")).toHaveCount(0);
});

// Changes made quickly one after another, while the first is still being saved: the last one wins,
// also when it goes back to the value stored before.
test("the last of quick changes to the waiting fields is kept", async ({ page }) => {
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  const title = `Rychlé změny ${Date.now()}`;
  await page.locator(".capture input").fill(title);
  await page.locator(".capture input").press("Enter");
  let id = "";
  await expect.poll(async () => (id = (await serverEntities(page)).find((entity) => entity.title === title)?.id || ""), { timeout: 20_000 }).not.toBe("");
  await page.goto(`/?task=${id}`);
  await waitUntilSynced(page);
  const waiting = page.locator(".waitingField");
  await waiting.getByLabel("Čeká na odpověď nebo na někoho jiného").click();
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waiting === true, true);
  await waitUntilSynced(page);
  // Saves wait at the server meanwhile.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/store", async (route) => { if (route.request().method() === "PUT") await held; await route.continue(); });
  const field = waiting.getByLabel("Čeká na", { exact: true });
  await field.fill("Petr");
  await waiting.getByLabel("Připomenout").focus();
  await field.fill("");
  await waiting.getByLabel("Připomenout").fill("2030-01-15");
  await waiting.getByLabel("Připomenout").fill("");
  await page.locator(".detail input.titleEdit").focus();
  release();
  await waitUntilSynced(page);
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waitingFor === "" && entity.properties?.followUpDate === "", true);
  await expect(field).toHaveValue("");
  await expect(waiting.getByLabel("Připomenout")).toHaveValue("");
});
