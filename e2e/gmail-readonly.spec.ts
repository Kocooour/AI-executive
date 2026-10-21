import { expect, test } from "./fixtures";
import { settingsSections, waitUntilSynced } from "./helpers";

// The server retains credentials; browser tests intercept mail requests instead of
// connecting to a real Google account. No OAuth secrets or mail content enter fixtures.
for (const width of [390, 1280]) {
  test(`Mail Settings: read-only inbox and workspace boundaries at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const account = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "preview@example.com" };
    await page.route("**/api/mail/gmail?*", async (route) => {
      const scope = new URL(route.request().url()).searchParams.get("workspaceId");
      if (scope !== "personal") return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Workspace not found"}' });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [account] }) });
    });
    await page.route("**/api/mail/gmail/messages", async (route) => {
      const body = route.request().postDataJSON();
      expect(body.workspaceId).toBe("personal");
      expect(body.accountId).toBe(account.id);
      expect(["inbox", "sent"]).toContain(body.folder);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [{
        id: "ab123456789", threadId: "thread-x", subject: "Ukázka zprávy", from: "alice@example.com",
        to: "preview@example.com", date: "21. října", snippet: "Jen náhled, bez ukládání", unread: true,
      }] }) });
    });
    await page.goto("/?view=Settings");
    await waitUntilSynced(page);
    await settingsSections(page).filter({ hasText: "Pošta" }).click();
    const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
    await expect(section.getByText("preview@example.com")).toBeVisible();
    await expect(section.getByRole("button", { name: "Připojit Gmail" })).toBeVisible();
    await section.getByRole("button", { name: "Doručené" }).click();
    await expect(section).toContainText("Ukázka zprávy");
    await expect(section).toContainText("alice@example.com");
    await expect(section).toContainText("Jen náhled, bez ukládání");
    await expect(section.getByRole("button", { name: "Odeslané" })).toBeVisible();
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // Another workspace cannot reuse the old Gmail account, even for one render.
    await settingsSections(page).filter({ hasText: "Prostor" }).click();
    await page.getByLabel("Aktuální pohled").selectOption("all");
    await settingsSections(page).filter({ hasText: "Pošta" }).click();
    await expect(section).toContainText("Nejprve vyber konkrétní prostor");
    await expect(section).not.toContainText("Ukázka zprávy");
    await expect(section).not.toContainText("preview@example.com");
    await expect(section.getByRole("button", { name: "Připojit Gmail" })).toHaveCount(0);
  });
}
