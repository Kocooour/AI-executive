import { test, expect } from "./fixtures";
import { waitUntilSynced } from "./helpers";

test.describe("mobile proposal approval", () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });

  test("shows impact and blocks a conflicting proposal after the checked command refuses it", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    const proposalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let confirmCalls = 0;
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      message: "Připravil jsem návrh.", proposal: {
        id: proposalId, summary: "Přesunout úkol ‚Příprava‘", workspaceId: "personal", expiresAt: Date.now() + 300_000,
        changes: [{ label: "Workspace", value: "Personal" }],
        review: { target: "Příprava", workspace: "Personal", fields: [{ label: "When", before: "Dnes", after: "Zítra" }],
          related: ["Plán"], sideEffects: ["approvalTaskSync", "approvalNoExternalWrite"] },
      },
    }) }));
    await page.route("**/api/ai/actions", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "confirm") confirmCalls++;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Data changed after this proposal was created. Ask the assistant again." }) });
    });
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await page.locator(".assistantComposer input").fill("Přesuň Přípravu na zítra");
    await page.locator(".assistantComposer input").press("Enter");
    await page.getByRole("button", { name: "Zkontrolovat návrh" }).click();
    const sheet = page.getByRole("dialog", { name: "Zkontrolovat návrh" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Personal");
    await expect(sheet).toContainText("Dnes → Zítra");
    await expect(sheet).toContainText("Plán");
    await expect(sheet).toContainText("synchronizuje ho");
    await expect(sheet.getByRole("button", { name: "Schválit změnu" })).toBeEnabled();
    await expect(sheet.getByRole("button", { name: "Odmítnout" })).toBeEnabled();
    await sheet.getByRole("button", { name: "Schválit změnu" }).click();
    await expect(sheet.getByRole("button", { name: "Schválit změnu" })).toBeDisabled();
    await expect(sheet.getByRole("alert")).toContainText("změnila");
    expect(confirmCalls).toBe(1);
    await sheet.locator("summary").click();
    await expect(sheet).toContainText("externího kalendáře");
  });

  test("expired proposal can be reviewed and rejected, but cannot be approved", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    let confirmCalls = 0;
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      message: "Připravil jsem návrh.", proposal: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", summary: "Dokončit úkol", workspaceId: "personal", expiresAt: Date.now() - 1000,
        changes: [{ label: "Workspace", value: "Personal" }],
        review: { target: "Úkol", workspace: "Personal", fields: [{ label: "Status", before: "open", after: "completed" }], related: [], sideEffects: ["approvalTaskSync"] },
      },
    }) }));
    await page.route("**/api/ai/actions", async (route) => {
      if (route.request().postDataJSON().action === "confirm") confirmCalls++;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await page.locator(".assistantComposer input").fill("Dokonči úkol");
    await page.locator(".assistantComposer input").press("Enter");
    await page.getByRole("button", { name: "Zkontrolovat návrh" }).click();
    const sheet = page.getByRole("dialog", { name: "Zkontrolovat návrh" });
    await expect(sheet.getByRole("button", { name: "Schválit změnu" })).toBeDisabled();
    await expect(sheet.getByRole("alert")).toContainText("Platnost návrhu skončila");
    await expect(sheet.getByRole("button", { name: "Odmítnout" })).toBeEnabled();
    expect(confirmCalls).toBe(0);
  });
});
