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
    await page.route("**/api/mail/gmail/message", async (route) => {
      const body = route.request().postDataJSON();
      expect(body).toEqual({ workspaceId: "personal", accountId: account.id, messageId: "ab123456789" });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: {
        id: "ab123456789", threadId: "thread-x", subject: "Ukázka zprávy",
        from: "alice@example.com", to: account.email, date: "21. října",
        text: "Bezpečný text zprávy <img src=x onerror=alert(1)>",
        truncated: false,
      } }) });
    });
    await section.getByRole("button", { name: "Přečíst zprávu" }).click();
    await expect(section.getByRole("region", { name: "Detail e-mailu" })).toContainText("Bezpečný text zprávy");
    await expect(section.getByLabel("Název úkolu")).toHaveValue("Vyřídit: Ukázka zprávy");
    expect(await page.locator("img[src='x']").count()).toBe(0);
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // Another workspace cannot reuse the old Gmail account, even for one render.
    await settingsSections(page).filter({ hasText: "Workspace" }).click();
    await page.getByLabel("Aktuální pohled").selectOption("all");
    await settingsSections(page).filter({ hasText: "Pošta" }).click();
    await expect(section).toContainText("Nejprve vyber konkrétní prostor");
    await expect(section).not.toContainText("Ukázka zprávy");
    await expect(section).not.toContainText("preview@example.com");
    await expect(section).not.toContainText("Bezpečný text zprávy");
    await expect(section.getByRole("button", { name: "Připojit Gmail" })).toHaveCount(0);
  });
}


test("OAuth completion uses the first-party session, removes the code from history and handles failures", async ({ page, browser, baseURL }) => {
  const state = "Q".repeat(43);
  const posted: Array<{ state: string; code: string; cookie: string; origin: string; referer: string }> = [];
  // Google token/profile exchange is exercised separately by the server unit test;
  // this browser test exercises the actual strict-cookie completion script.
  await page.route("**/api/mail/gmail/callback", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = request.postDataJSON() as { state: string; code: string };
    const headers = request.headers();
    posted.push({ ...body, cookie: headers.cookie || "", origin: headers.origin || "", referer: headers.referer || "" });
    return route.fulfill({
      status: posted.length === 1 ? 200 : 400,
      contentType: "application/json",
      body: posted.length === 1 ? '{"connected":true}' : '{"error":"expired"}',
    });
  });

  await page.goto("/api/mail/gmail/callback?state=" + state + "&code=ONE-TIME-AUTH-CODE");
  await expect(page).toHaveURL(/\?view=Settings&gmail=connected/);
  expect(posted).toHaveLength(1);
  expect(posted[0].state).toBe(state);
  expect(posted[0].code).toBe("ONE-TIME-AUTH-CODE");
  expect(posted[0].origin).toBe(new URL(baseURL!).origin);
  expect(posted[0].cookie).toContain("ai_executive_session=");
  expect(posted[0].referer).not.toContain("ONE-TIME-AUTH-CODE");

  // A genuinely anonymous session cannot complete even a well-shaped callback.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const response = await anonymous.request.post(baseURL! + "/api/mail/gmail/callback", {
      headers: { origin: new URL(baseURL!).origin, "content-type": "application/json" },
      data: { state, code: "ONE-TIME-AUTH-CODE" },
    });
    expect(response.status()).toBe(401);
  } finally { await anonymous.close(); }

  // Invalid/replayed completion leaves the user on a safe error page; the code
  // must already be absent from the address bar and history.
  await page.goto("/api/mail/gmail/callback?state=" + state + "&code=REPLAYED-AUTH-CODE");
  await expect(page.getByText("Připojení se nezdařilo.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/api\/mail\/gmail\/callback$/);
  expect(posted).toHaveLength(2);
  expect(posted[1].code).toBe("REPLAYED-AUTH-CODE");
});
