import { expect, test } from "./fixtures";
import { confirmDialog, settingsSections, waitUntilSynced } from "./helpers";

// All responses are synthetic; no real Google account is used.
for (const width of [390, 1280]) {
  test("Mail v4 consent, status, manual sync and complete deletion at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const account = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "synced@example.com" };
    const calls: string[] = [];
    let syncEnabled = false, retentionDays = 30, indexedCount = 0;
    await page.route("**/api/mail/gmail?*", async (route) => {
      const workspace = new URL(route.request().url()).searchParams.get("workspaceId");
      await route.fulfill({ status: workspace === "personal" ? 200 : 404,
        contentType: "application/json", body: JSON.stringify({ accounts: workspace === "personal" ? [account] : [] }) });
    });
    await page.route("**/api/mail/gmail/sync", async (route) => {
      const body = route.request().postDataJSON();
      calls.push(body.action);
      expect(route.request().method()).toBe("POST");
      expect(body.workspaceId).toBe("personal");
      if (body.action !== "status") expect(body.accountId).toBe(account.id);
      if (body.action === "enable") {
        retentionDays = body.retentionDays;
        syncEnabled = true;
      }
      if (body.action === "disable") {
        syncEnabled = false;
        indexedCount = 0;
      }
      if (body.action === "sync") {
        expect(syncEnabled).toBe(true);
        indexedCount = 2;
      }
      const accounts = syncEnabled ? [{ accountId: account.id, workspaceId: "personal", enabled: true,
        retentionDays, indexedCount, lastSyncedAt: indexedCount ? Date.now() : null }] : [];
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body.action === "sync"
        ? { full: true, updated: 2, state: accounts[0] } : { accounts }) });
    });
    await page.goto("/?view=Settings");
    await waitUntilSynced(page);
    await settingsSections(page).filter({ hasText: "Pošta" }).click();
    const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
    await expect(section.getByText("synced@example.com")).toBeVisible();
    await expect(section.getByText("Synchronizace vypnutá")).toBeVisible();
    expect(calls, "nothing is synchronized automatically").toEqual(["status"]);
    await section.getByLabel("Uchovávání").selectOption("7");
    await section.getByRole("button", { name: "Zapnout synchronizaci" }).click();
    await expect(section.getByText(/Synchronizace zapnutá/)).toBeVisible();
    expect(retentionDays).toBe(7);
    expect(indexedCount).toBe(0);
    await section.getByRole("button", { name: "Synchronizovat nyní" }).click();
    await expect(section.getByText(/2 záznamů/)).toBeVisible();
    expect(indexedCount).toBe(2);
    await section.getByRole("button", { name: "Vypnout a smazat metadata" }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await confirmDialog(page).getByRole("button", { name: "Vypnout a smazat" }).click();
    await expect(section.getByText("Synchronizace vypnutá")).toBeVisible();
    expect(indexedCount).toBe(0);
    expect(calls).toEqual(["status", "enable", "sync", "status", "disable"]);
    await settingsSections(page).filter({ hasText: "Workspace" }).click();
    await page.getByLabel("Aktuální pohled").selectOption("all");
    await settingsSections(page).filter({ hasText: "Pošta" }).click();
    await expect(section).not.toContainText("synced@example.com");
    if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}


test("Mail v4 status API outage does not hide connected Gmail accounts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const accountId = "11111111-1111-4111-8111-111111111111";
  await page.route("**/api/mail/gmail?*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      accounts: [{ id: accountId, workspaceId: "personal", email: "survives@example.com" }],
    }) });
  });
  await page.route("**/api/mail/gmail/sync", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json",
      body: '{"error":"Mail sync failed"}' });
  });
  await page.route("**/api/mail/gmail/messages", async (route) => {
    expect(route.request().postDataJSON().accountId).toBe(accountId);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [{
      id: "abcdef1234", threadId: "abcdef1234", subject: "Mailbox still readable",
      from: "sender@example.com", to: "survives@example.com", date: "today",
      snippet: "No sync status required", unread: false,
    }] }) });
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("survives@example.com")).toBeVisible();
  await expect(section.getByText("Stav synchronizace není dostupný.", { exact: false })).toBeVisible();
  await expect(section.getByText("Stav neznámý", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Zapnout synchronizaci" })).toBeDisabled();
  await expect(section.getByLabel("Uchovávání")).toBeDisabled();
  await expect(section).not.toContainText("Synchronizace vypnutá");
  await expect(section.getByRole("button", { name: "Odpojit" })).toBeVisible();
  await section.getByRole("button", { name: "Doručené" }).click();
  await expect(section).toContainText("Mailbox still readable");
});


test("Mail v4 persistently shows incomplete metadata reconciliation across page reload", async ({ page }) => {
  await page.route("**/api/mail/gmail?*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      accounts: [{ id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "reconcile@example.com" }],
    }) });
  });
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(
      body.action === "status" ? { accounts: [{
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "personal", enabled: true, retentionDays: 7, indexedCount: 180,
        reconciliationPending: 60, lastSyncedAt: Date.now(),
      }] } : { error: "unexpected action" },
    ) });
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("reconcile@example.com")).toBeVisible();
  await expect(section.getByText(/Nevyřízené ověření dřívějších metadat: 60/)).toBeVisible();
  await expect(section.getByLabel("Uchovávání")).toHaveValue("7");
  await page.reload();
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  await expect(section.getByText(/Nevyřízené ověření dřívějších metadat: 60/)).toBeVisible();
});
