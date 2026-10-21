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
    expect(calls).toEqual(["status"], "nothing is synchronized automatically");
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
