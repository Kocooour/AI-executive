import { expect, test } from "./fixtures";
import { openMailReader, openSettings, settingsSections, waitUntilSynced } from "./helpers";

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
    // Settings -> Mail keeps the accounts and their sync controls; reading mail moved to Inbox -> "Z pošty".
    await expect(section.getByRole("button", { name: "Doručené" })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Přečíst zprávu" })).toHaveCount(0);
    await section.getByRole("button", { name: "Číst poštu v Doručených" }).click();
    await expect(page.locator('[data-inbox-tab="mail"]')).toHaveAttribute("aria-pressed", "true");
    const reader = page.locator(".mailReader");
    await expect(reader.getByText("preview@example.com")).toBeVisible();
    await reader.getByRole("button", { name: "Doručené" }).click();
    await expect(reader).toContainText("Ukázka zprávy");
    await expect(reader).toContainText("alice@example.com");
    await expect(reader).toContainText("Jen náhled, bez ukládání");
    await expect(reader.getByRole("button", { name: "Odeslané" })).toBeVisible();
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
    await reader.getByRole("button", { name: "Přečíst zprávu" }).click();
    await expect(reader.getByRole("region", { name: "Detail e-mailu" })).toContainText("Bezpečný text zprávy");
    await expect(reader.getByLabel("Název úkolu")).toHaveValue("Vyřídit: Ukázka zprávy");
    expect(await page.locator("img[src='x']").count()).toBe(0);
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // Another workspace cannot reuse the old Gmail account, even for one render.
    await openSettings(page);
    await settingsSections(page).filter({ hasText: "Workspace" }).click();
    await page.getByLabel("Aktuální pohled").selectOption("all");
    await settingsSections(page).filter({ hasText: "Pošta" }).click();
    await expect(section).toContainText("Nejprve vyber konkrétní prostor");
    await expect(section).not.toContainText("Ukázka zprávy");
    await expect(section).not.toContainText("preview@example.com");
    await expect(section).not.toContainText("Bezpečný text zprávy");
    await expect(section.getByRole("button", { name: "Připojit Gmail" })).toHaveCount(0);
    // The reader in Inbox obeys the same boundary: All my work cannot read mail.
    const aggregateReader = await openMailReader(page);
    await expect(aggregateReader).toContainText("nemůže");
    await expect(aggregateReader).not.toContainText("Ukázka zprávy");
    await expect(aggregateReader).not.toContainText("preview@example.com");
    await expect(aggregateReader).not.toContainText("Bezpečný text zprávy");
    await expect(aggregateReader.getByRole("button", { name: "Doručené" })).toHaveCount(0);
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

  // The app rewrites the address right after it loads, so the redirect is caught as a navigation,
  // and the rewrite is awaited so it cannot interrupt the next navigation below.
  const connected = page.waitForURL(/\?view=Settings&gmail=connected/, { waitUntil: "commit" });
  await page.goto("/api/mail/gmail/callback?state=" + state + "&code=ONE-TIME-AUTH-CODE");
  await connected;
  await expect(page).toHaveURL(/\/\?view=Settings$/);
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


// Thread navigation never retrieves full bodies until an explicit message click.
// Exercise both mobile and desktop against deterministic mock Gmail responses.
for (const width of [390, 1280]) {
  test("Gmail conversation metadata can open an individual message at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const accountId = "11111111-1111-4111-8111-111111111111";
    const threadId = "abcddcba";
    const firstId = "aabbcc11", replyId = "aabbcc22";
    let detailRequests = 0;
    await page.route("**/api/mail/gmail?*", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        accounts: [{ id: accountId, workspaceId: "personal", email: "reader@example.com" }],
      }) });
    });
    await page.route("**/api/mail/gmail/messages", async (route) => {
      const body = route.request().postDataJSON();
      expect(body.workspaceId).toBe("personal");
      expect(body.accountId).toBe(accountId);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [{
        id: firstId, threadId, subject: "Původní zpráva",
        from: "sender@example.com", to: "reader@example.com", date: "21. října",
        snippet: "Zobrazit konverzaci", unread: false,
      }] }) });
    });
    await page.route("**/api/mail/gmail/message", async (route) => {
      const body = route.request().postDataJSON();
      expect(body).toEqual({ workspaceId: "personal", accountId, messageId: body.messageId });
      expect([firstId, replyId]).toContain(body.messageId);
      detailRequests++;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: {
        id: body.messageId, threadId, subject: body.messageId === firstId ? "Původní zpráva" : "Odpověď",
        from: "sender@example.com", to: "reader@example.com", date: "21. října",
        text: body.messageId === firstId ? "První text zprávy" : "Druhý text zprávy",
        truncated: false,
      } }) });
    });
    await page.route("**/api/mail/gmail/thread", async (route) => {
      expect(route.request().method()).toBe("POST");
      const body = route.request().postDataJSON();
      expect(body).toEqual({ workspaceId: "personal", accountId, threadId });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ thread: {
        id: threadId, total: 2, omitted: 0,
        messages: [
          { id: firstId, threadId, subject: "Původní zpráva", from: "sender@example.com",
            date: "21. října", to: "reader@example.com", snippet: "První náhled", unread: false },
          { id: replyId, threadId, subject: "Odpověď", from: "reader@example.com",
            date: "21. října", to: "sender@example.com",
            snippet: "<img src=x onerror=alert(1)>", unread: true },
        ],
      } }) });
    });
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const panel = await openMailReader(page);
    await panel.getByRole("button", { name: "Doručené" }).click();
    await panel.getByRole("button", { name: "Přečíst zprávu" }).click();
    await expect(page.getByRole("region", { name: "Detail e-mailu" })).toContainText("První text zprávy");
    await panel.getByRole("button", { name: "Zobrazit konverzaci" }).click();
    const thread = page.getByRole("region", { name: "Konverzace Gmail" });
    await expect(thread).toContainText("Konverzace (2)");
    await expect(thread.getByRole("button", { name: "Přečíst v konverzaci" })).toHaveCount(2);
    expect(detailRequests, "metadata-only conversation did not fetch full messages").toBe(1);
    expect(await page.locator("img[src='x']").count()).toBe(0);
    await thread.getByRole("button", { name: "Přečíst v konverzaci" }).nth(1).click();
    await expect(page.getByRole("region", { name: "Detail e-mailu" })).toContainText("Druhý text zprávy");
    expect(detailRequests).toBe(2);
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await openSettings(page);
    await settingsSections(page).filter({ hasText: "Workspace" }).click();
    await page.getByLabel("Aktuální pohled").selectOption("all");
    await openMailReader(page);
    await expect(page.getByRole("region", { name: "Konverzace Gmail" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Detail e-mailu" })).toHaveCount(0);
  });
}


// A user can dismiss the email detail while the thread request is still
// pending. The obsolete result must neither resurrect the thread nor leave
// a permanently disabled "Show conversation" button.
for (const width of [390, 1280]) {
  test("closing mail detail cancels pending conversation UI at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const accountId = "11111111-1111-4111-8111-111111111111";
    const threadId = "abcdef12";
    const messageId = "fedcba12";
    let firstSeen!: () => void;
    let releaseFirst!: () => void;
    const firstArrived = new Promise<void>((resolve) => { firstSeen = resolve; });
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let threadReads = 0;

    await page.route("**/api/mail/gmail?*", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        accounts: [{ id: accountId, workspaceId: "personal", email: "reader@example.com" }],
      }) });
    });
    await page.route("**/api/mail/gmail/messages", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [{
        id: messageId, threadId, subject: "Původní zpráva", from: "sender@example.com",
        to: "reader@example.com", date: "21. října", snippet: "První náhled", unread: false,
      }] }) });
    });
    await page.route("**/api/mail/gmail/message", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ workspaceId: "personal", accountId, messageId });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: {
        id: messageId, threadId, subject: "Původní zpráva", from: "sender@example.com",
        to: "reader@example.com", date: "21. října", text: "Čitelný obsah", truncated: false,
      } }) });
    });
    await page.route("**/api/mail/gmail/thread", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ workspaceId: "personal", accountId, threadId });
      threadReads++;
      if (threadReads === 1) {
        firstSeen();
        await firstHold;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ thread: {
        id: threadId, total: 1, omitted: 0, messages: [{
          id: messageId, threadId, subject: "Původní zpráva", from: "sender@example.com",
          to: "reader@example.com", date: "21. října", snippet: "První náhled", unread: false,
        }],
      } }) });
    });

    try {
      await page.goto("/?view=Inbox");
      await waitUntilSynced(page);
      const panel = await openMailReader(page);
      await panel.getByRole("button", { name: "Doručené" }).click();
      await panel.getByRole("button", { name: "Přečíst zprávu" }).click();
      const detail = panel.getByRole("region", { name: "Detail e-mailu" });
      await expect(detail).toContainText("Čitelný obsah");
      await detail.getByRole("button", { name: "Zobrazit konverzaci" }).click();
      await firstArrived;
      await expect(panel.getByText("Načítám konverzaci…")).toBeVisible();

      // Previously this incremented detailVersion without resetting threadBusy.
      await detail.getByRole("button", { name: "Zavřít" }).click();
      await expect(panel.getByText("Načítám konverzaci…")).toHaveCount(0);
      const obsoleteResponse = page.waitForResponse((resp) =>
        resp.url().includes("/api/mail/gmail/thread") && resp.request().method() === "POST",
      );
      releaseFirst();
      await obsoleteResponse;
      await expect(panel.getByRole("region", { name: "Konverzace Gmail" })).toHaveCount(0);

      // The old request cannot re-open the thread, and a fresh request works.
      await panel.getByRole("button", { name: "Přečíst zprávu" }).click();
      await expect(panel.getByRole("region", { name: "Detail e-mailu" })).toBeVisible();
      await panel.getByRole("button", { name: "Zobrazit konverzaci" }).click();
      await expect(panel.getByRole("region", { name: "Konverzace Gmail" })).toContainText("Konverzace (1)");
      expect(threadReads).toBe(2);
    } finally {
      releaseFirst();
    }
  });
}

test("switching folders while a message is still loading keeps the reader usable", async ({ page }) => {
  const account = { id: "33333333-3333-4333-8333-333333333333", workspaceId: "personal", email: "folders@example.com" };
  const listed = (id: string, subject: string) => ({ id, threadId: `t${id}`, subject, from: "sender@example.com",
    to: account.email, date: "21. října", snippet: "Náhled", unread: false });
  let releaseDetail!: () => void;
  const detailHold = new Promise<void>((resolve) => { releaseDetail = resolve; });
  let detailSeen!: () => void;
  const detailArrived = new Promise<void>((resolve) => { detailSeen = resolve; });
  let detailReads = 0;
  await page.route("**/api/mail/gmail?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [account] }) }));
  await page.route("**/api/mail/gmail/messages", (route) => {
    const folder = route.request().postDataJSON().folder;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      messages: [folder === "sent" ? listed("bb200000001", "Odeslaná zpráva") : listed("aa100000001", "Došlá zpráva")] }) });
  });
  await page.route("**/api/mail/gmail/message", async (route) => {
    detailReads++;
    const { messageId } = route.request().postDataJSON();
    if (detailReads === 1) { detailSeen(); await detailHold; }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ message: {
      ...listed(messageId, messageId === "bb200000001" ? "Odeslaná zpráva" : "Došlá zpráva"), text: "Obsah zprávy", truncated: false } }) });
  });
  try {
    await page.goto("/?view=Inbox");
    await waitUntilSynced(page);
    const reader = await openMailReader(page);
    await reader.getByRole("button", { name: "Doručené" }).click();
    await reader.getByRole("button", { name: "Přečíst zprávu" }).click();
    await detailArrived;
    // The first message is still loading when the owner switches to Sent.
    await reader.getByRole("button", { name: "Odeslané" }).click();
    await expect(reader).toContainText("Odeslaná zpráva");
    releaseDetail();
    // The stale answer neither shows nor keeps the reader busy: the next message can be opened.
    const read = reader.getByRole("button", { name: "Přečíst zprávu" });
    await expect(read).toBeEnabled();
    await read.click();
    const detail = reader.getByRole("region", { name: "Detail e-mailu" });
    await expect(detail).toContainText("Odeslaná zpráva");
    await expect(detail).not.toContainText("Došlá zpráva");
  } finally {
    releaseDetail();
  }
});
