import { expect, test } from "./fixtures";
import { gmailMockPort } from "../playwright.config";
import { startGmailMock, mockGmailAddress, mockGmailRefresh, mockGmailAccess, type GmailMock } from "./gmail-mock";
import { settingsSections, waitUntilSynced } from "./helpers";

// The application runs a production build against the on-loopback E2E Google stub.
// No live Gmail is contacted. Test both OAuth page and the actual first-party POST
// carrying Lumi's SameSite=Strict owner session.
let google: GmailMock;
test.beforeAll(async () => { google = await startGmailMock(gmailMockPort); });
test.afterAll(async () => { await google?.close(); });

test("Gmail authorization from Settings exchanges a one-use code and reads mailbox with owner session", async ({ page }) => {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await settingsSections(page).filter({ hasText: "Pošta" }).click();
  await expect(page.getByRole("button", { name: "Připojit Gmail" })).toBeVisible();
  await page.route("https://accounts.google.com/o/oauth2/v2/auth**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,60}$/);
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", state!);
    redirect.searchParams.set("code", "E2E-FAKE-CODE");
    await route.fulfill({ status: 302, headers: { location: redirect.toString(), "cache-control": "no-store" }, body: "" });
  });
  // Settings strips ?gmail=connected right after it renders, so polling the URL can miss it;
  // wait for the completion page's navigation itself instead.
  const connected = page.waitForURL(/gmail=connected/, { timeout: 25_000 });
  await page.getByRole("button", { name: "Připojit Gmail" }).click();
  await connected;
  await expect(page.getByText(mockGmailAddress, { exact: true })).toBeVisible({ timeout: 20_000 });
  const section = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await section.getByRole("button", { name: "Doručené" }).click();
  await expect(section).toContainText("Gmail OAuth E2E");
  await expect(section).toContainText("Zpráva z lokálního mocku");
  await section.getByRole("button", { name: "Přečíst zprávu" }).click();
  await expect(section.getByRole("region", { name: "Detail e-mailu" })).toContainText("E2E zpráva pro vytvoření úkolu.");
  await expect(section.getByLabel("Název úkolu")).toHaveValue("Vyřídit: Gmail OAuth E2E");
  // A task is a separate, explicit local-first write. The Gmail scope remains read-only.
  await section.getByLabel("Název úkolu").fill("Vyřešit testovací požadavek z Gmailu zítra 25.10. #high");
  await section.getByRole("button", { name: "Potvrdit a vytvořit úkol" }).click();
  await expect(section).toContainText("Úkol byl vytvořen v Inboxu.");
  await section.getByRole("button", { name: "Přejít do Inboxu" }).click();
  await expect(page.getByText("Vyřešit testovací požadavek z Gmailu zítra 25.10. #high", { exact: true }).first()).toBeVisible();
  // Assert the task's source is stable canonical metadata, not copied email
  // content; the browser's local-first record is eventually synced to SQLite.
  const saved = await page.evaluate(async () => {
    const opened = indexedDB.open("ai-executive");
    return new Promise<{ mailSource: unknown; propertiesText: string } | null>((resolve, reject) => {
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const database = opened.result;
        const request = database.transaction("entities", "readonly").objectStore("entities").getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const task = (request.result as Array<{ title: string; type: string; properties: Record<string, unknown> }>).find(
            (row) => row.type === "task" && row.title === "Vyřešit testovací požadavek z Gmailu zítra 25.10. #high",
          );
          resolve(task ? { mailSource: task.properties.mailSource, propertiesText: JSON.stringify(task.properties) } : null);
          database.close();
        };
      };
    });
  });
  expect(saved?.mailSource).toEqual({
    provider: "gmail", accountId: expect.any(String), messageId: "abc123def456", threadId: "thread-e2e",
  });
  // Mail titles are literal, even when their wording resembles Quick Capture
  // commands. The default inbox placement must not turn into a due date.
  expect(saved?.propertiesText).toContain('"inbox":true');
  expect(saved?.propertiesText).toContain('"today":false');
  expect(saved?.propertiesText).not.toContain('"when":');
  expect(saved?.propertiesText).not.toContain('"priority":');
  expect(saved?.propertiesText).not.toContain('"literalTaskTitle":');
  expect(saved?.propertiesText).not.toContain("E2E zpráva pro vytvoření úkolu.");
  const taskRow = page.locator(".taskRow", { hasText: "Vyřešit testovací požadavek z Gmailu zítra 25.10. #high" }).first();
  await taskRow.locator(".taskRowOpen").click();
  const inspector = page.locator(".inspectorDetail");
  await expect(inspector.getByRole("region", { name: "Zdrojový e-mail" })).toContainText("Gmail");
  await inspector.getByRole("button", { name: "Otevřít zdrojovou zprávu" }).click();
  await expect(page).toHaveURL(/view=Settings/);
  const reopened = page.locator(".settingsPanel section").filter({ has: page.getByRole("heading", { name: "Pošta" }) });
  await expect(reopened.getByRole("region", { name: "Detail e-mailu" })).toContainText("E2E zpráva pro vytvoření úkolu.");
  const data = await page.evaluate(async () => JSON.stringify({
    local: { ...localStorage }, session: { ...sessionStorage },
    account: await fetch("/api/mail/gmail?workspaceId=personal", { cache: "no-store" }).then((r) => r.json()),
  }));
  expect(data).not.toContain(mockGmailRefresh);
  expect(data).not.toContain(mockGmailAccess);
  expect(google.requests.some((r) => r.path === "/token" && r.body.includes("grant_type=authorization_code"))).toBe(true);
  expect(google.requests.some((r) => r.path.includes("/gmail/v1/users/me/messages"))).toBe(true);
  expect(google.requests.some((r) => r.path.includes("format=full"))).toBe(true);
  expect(google.requests.some((r) => /\/send|\/modify|\/trash/.test(r.path))).toBe(false);
});
