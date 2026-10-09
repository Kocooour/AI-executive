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
  await expectOnServer(page, (entity) => entity.id === id && entity.properties?.waiting === true && entity.properties?.waitingFor === "Petr" && entity.properties?.followUpDate === today, true);
  await page.goto("/?view=Inbox");
  await expect(page.locator("article", { hasText: title })).toContainText("Čeká: Petr");
  await page.goto("/");
  await waitUntilSynced(page);
  const item = page.locator(".attentionItem", { hasText: title });
  await expect(item).toContainText("Nastal den připomenutí");
  await expect(item).toContainText("čeká na: Petr");
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
});
