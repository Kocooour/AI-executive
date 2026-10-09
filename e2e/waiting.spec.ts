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
  await expect(page.locator("article", { hasText: title })).toContainText("Čeká: Petr");
  // Changing who it waits for and closing the detail at once does not open the task again when
  // the change is saved.
  await page.locator("article", { hasText: title }).click();
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
  await expect(item).toContainText("označeno jako čekající");
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
