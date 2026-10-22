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
    expect(calls).toEqual(["status", "enable", "sync", "disable"]);
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
  let optOutCalls = 0;
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const action = route.request().postDataJSON().action;
    if (action === "disable") {
      optOutCalls++;
      await route.fulfill({ contentType: "application/json", body: '{"accounts":[]}' });
    } else {
      await route.fulfill({ status: 503, contentType: "application/json",
        body: '{"error":"Mail sync failed"}' });
    }
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
  // Owner must be able to erase indexed subjects/senders even if status is down.
  const optOut = section.getByRole("button", { name: "Vypnout a smazat metadata" });
  await expect(optOut).toBeEnabled();
  await optOut.click();
  await confirmDialog(page).getByRole("button", { name: "Vypnout a smazat" }).click();
  await expect(section.getByText("Synchronizace vypnutá")).toBeVisible();
  expect(optOutCalls).toBe(1);
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


test("Mail v4 shows persistent Gmail history and discovery backlogs after reload", async ({ page }) => {
  await page.route("**/api/mail/gmail?*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      accounts: [{ id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "unfinished@example.com" }],
    }) });
  });
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(
      body.action === "status" ? { accounts: [{
        accountId: "11111111-1111-4111-8111-111111111111", workspaceId: "personal",
        enabled: true, retentionDays: 30, indexedCount: 120, reconciliationPending: 0,
        historyPending: true, discoveryPending: true, lastSyncedAt: Date.now(),
      }] } : { error: "unexpected action" },
    ) });
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("unfinished@example.com")).toBeVisible();
  await expect(section.getByText(/Čekají další změny z historie Gmailu/)).toBeVisible();
  await expect(section.getByText(/Probíhá dohledávání dalších zpráv/)).toBeVisible();
  await page.reload();
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  await expect(section.getByText(/Čekají další změny z historie Gmailu/)).toBeVisible();
  await expect(section.getByText(/Probíhá dohledávání dalších zpráv/)).toBeVisible();
});


test("Mail v4 retention Save never silently changes an unchanged 7-day policy to 30 days", async ({ page }) => {
  const account = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal",
    email: "retention-seven@example.com" };
  let retentionDays = 7;
  const enableCalls: number[] = [];
  await page.route("**/api/mail/gmail?*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [account] }) });
  });
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "enable") {
      enableCalls.push(body.retentionDays);
      retentionDays = body.retentionDays;
    }
    expect(["status", "enable"]).toContain(body.action);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      accounts: [{ accountId: account.id, workspaceId: "personal", enabled: true, retentionDays,
        indexedCount: 1, reconciliationPending: 0, lastSyncedAt: Date.now() }],
    }) });
  });

  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({
    has: page.getByRole("heading", { name: "Pošta" }),
  });
  const select = section.getByLabel("Uchovávání");
  const save = section.getByRole("button", { name: "Uložit uchovávání" });
  await expect(section.getByText("retention-seven@example.com")).toBeVisible();
  await expect(select).toHaveValue("7");
  await expect(save).toBeDisabled();
  expect(enableCalls).toEqual([]);

  await page.reload();
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  await expect(select).toHaveValue("7");
  await expect(save).toBeDisabled();
  expect(enableCalls).toEqual([]);

  await select.selectOption("30");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(select).toHaveValue("30");
  await expect(save).toBeDisabled();
  expect(enableCalls).toEqual([30]);

  await select.selectOption("7");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(select).toHaveValue("7");
  await expect(save).toBeDisabled();
  expect(enableCalls).toEqual([30, 7]);
});


test("Mail v4 sync-status retry recovers without page reload after a transient 503", async ({ page }) => {
  const account = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "retry@example.com" };
  let statusCalls = 0;
  await page.route("**/api/mail/gmail?*", async (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [account] }) }));
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.action).toBe("status");
    statusCalls++;
    if (statusCalls === 1) await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary"}' });
    else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [
      { accountId: account.id, workspaceId: "personal", enabled: true, retentionDays: 7,
        indexedCount: 8, lastSyncedAt: Date.now() },
    ] }) });
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("retry@example.com")).toBeVisible();
  await expect(section.getByText("Stav neznámý")).toBeVisible();
  await expect(section.getByRole("button", { name: "Zapnout synchronizaci" })).toBeDisabled();
  await section.getByRole("button", { name: "Obnovit stav synchronizace" }).click();
  await expect(section.getByText("Synchronizace zapnutá", { exact: false })).toBeVisible();
  await expect(section.getByLabel("Uchovávání")).toHaveValue("7");
  await expect(section.getByRole("button", { name: "Synchronizovat nyní" })).toBeEnabled();
  expect(statusCalls).toBe(2);
});

test("Mail v4 committed sync uses its returned status without an extra status request", async ({ page }) => {
  const account = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "sync-result@example.com" };
  let statusCalls = 0, syncCalls = 0;
  await page.route("**/api/mail/gmail?*", async (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [account] }) }));
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "status") {
      statusCalls++;
      return route.fulfill({ status: statusCalls === 1 ? 200 : 503,
        contentType: "application/json", body: statusCalls === 1 ? JSON.stringify({ accounts: [{
          accountId: account.id, workspaceId: "personal", enabled: true, retentionDays: 7,
          indexedCount: 1, lastSyncedAt: Date.now(),
        }] }) : '{"error":"status outage"}' });
    }
    expect(body.action).toBe("sync");
    syncCalls++;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      full: false, partial: false, updated: 2, state: {
        accountId: account.id, workspaceId: "personal", enabled: true,
        retentionDays: 7, indexedCount: 3, lastSyncedAt: Date.now(),
      },
    }) });
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("sync-result@example.com")).toBeVisible();
  await expect(section.getByText("1 záznamů", { exact: false })).toBeVisible();
  await section.getByRole("button", { name: "Synchronizovat nyní" }).click();
  await expect(section.getByText("3 záznamů", { exact: false })).toBeVisible();
  await expect(section).not.toContainText("Synchronizace Gmailu se nezdařila.");
  expect(syncCalls).toBe(1);
  expect(statusCalls, "no follow-up status request after a successful sync").toBe(1);
});


test("Mail v4 ignores a late sync reply after workspace selection changes", async ({ page }) => {
  const account = { id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "personal", email: "scope-guard@example.com" };
  let statusCalls = 0;
  let sendLateReply: (() => void) | undefined;
  let notifySyncStarted: (() => void) | undefined;
  const syncStarted = new Promise<void>(resolve => { notifySyncStarted = resolve; });
  await page.route("**/api/mail/gmail?*", async route => {
    await route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ accounts: [account] }) });
  });
  await page.route("**/api/mail/gmail/sync", async route => {
    const body = route.request().postDataJSON();
    if (body.action === "status") {
      statusCalls++;
      const ok = statusCalls === 1;
      await route.fulfill({ status: ok ? 200 : 503, contentType: "application/json",
        body: ok ? JSON.stringify({ accounts: [{
          accountId: account.id, workspaceId: "personal", enabled: true,
          retentionDays: 7, indexedCount: 1, lastSyncedAt: Date.now(),
        }] }) : '{"error":"temporary unavailable"}' });
    } else if (body.action === "sync") {
      notifySyncStarted?.();
      await new Promise<void>(resolve => { sendLateReply = resolve; });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        full: false, updated: 2, partial: false, state: {
          accountId: account.id, workspaceId: "personal", enabled: true,
          retentionDays: 7, indexedCount: 3, lastSyncedAt: Date.now(),
        },
      }) });
    } else throw new Error("Unexpected mail sync action " + body.action);
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("scope-guard@example.com")).toBeVisible();
  await section.getByRole("button", { name: "Synchronizovat nyní" }).click();
  await syncStarted;
  await settingsSections(page).filter({ hasText: "Workspace" }).click();
  await page.getByLabel("Aktuální pohled").selectOption("all");
  await page.getByLabel("Aktuální pohled").selectOption("personal");
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  await expect(section.getByText("Stav neznámý")).toBeVisible();
  await expect(section.getByRole("button", { name: "Zapnout synchronizaci" })).toBeDisabled();
  sendLateReply?.();
  await page.waitForTimeout(150);
  await expect(section.getByText("Stav neznámý")).toBeVisible();
  await expect(section.getByRole("button", { name: "Zapnout synchronizaci" })).toBeDisabled();
  expect(statusCalls).toBeGreaterThanOrEqual(2);
});

test("Mail v4 ignores a status reply that started before a completed opt-out", async ({ page }) => {
  const account = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "personal", email: "late-status@example.com" };
  let releaseStatus: () => void = () => {};
  const statusHeld = new Promise<void>((resolve) => { releaseStatus = resolve; });
  let statusReplied = false;
  await page.route("**/api/mail/gmail?*", async (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [account] }) }));
  await page.route("**/api/mail/gmail/sync", async (route) => {
    const action = route.request().postDataJSON().action;
    if (action === "disable") {
      await route.fulfill({ contentType: "application/json", body: '{"accounts":[]}' });
      return;
    }
    expect(action).toBe("status");
    await statusHeld;
    // Stale snapshot from before the opt-out committed.
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: [
      { accountId: account.id, workspaceId: "personal", enabled: true, retentionDays: 30,
        indexedCount: 12, lastSyncedAt: Date.now() },
    ] }) });
    statusReplied = true;
  });
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(section.getByText("late-status@example.com")).toBeVisible();
  await expect(section.getByText("Stav neznámý")).toBeVisible();
  await section.getByRole("button", { name: "Vypnout a smazat metadata" }).click();
  await confirmDialog(page).getByRole("button", { name: "Vypnout a smazat" }).click();
  await expect(section.getByText("Synchronizace vypnutá")).toBeVisible();
  const lateReply = page.waitForResponse((response) => response.url().endsWith("/api/mail/gmail/sync")
    && response.request().postDataJSON().action === "status");
  releaseStatus();
  await lateReply;
  expect(statusReplied).toBe(true);
  // Give React the chance to apply the stale reply before checking it was ignored.
  await page.waitForTimeout(300);
  await expect(section.getByText("Synchronizace vypnutá")).toBeVisible();
  await expect(section).not.toContainText("Synchronizace zapnutá");
});
