import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";

test.describe("UI-08b desktop Lumi proposal review", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a proposed write is labeled and must be reviewed before it can be approved", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    let confirms = 0;
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      message: "Připravil jsem návrh.",
      proposal: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", summary: "Přeplánovat úkol", workspaceId: "personal", expiresAt: Date.now() + 60_000,
        changes: [{ label: "Workspace", value: "Personal" }],
        review: { target: "Kontrolní úkol", workspace: "Personal", fields: [{ label: "When", before: "Dnes", after: "Zítra" }], related: ["Projekt"], sideEffects: ["approvalTaskSync"] } },
    }) }));
    await page.route("**/api/ai/actions", async (route) => {
      if (route.request().postDataJSON().action === "confirm") confirms++;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Hotovo." }) });
    });
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await page.locator(".assistantComposer input").fill("Přeplánuj úkol");
    await page.locator(".assistantComposer input").press("Enter");
    const card = page.locator(".aiProposal").first();
    await expect(card.locator(".proposalOrigin")).toContainText("Návrh Lumi");
    await expect(card.getByRole("button", { name: "Zkontrolovat návrh" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Potvrdit" })).toHaveCount(0);
    expect(confirms).toBe(0);

    await card.getByRole("button", { name: "Zkontrolovat návrh" }).click();
    const review = page.getByRole("dialog", { name: "Zkontrolovat návrh" });
    await expect(review).toBeVisible();
    await expect(review).toContainText("Kontrolní úkol");
    await expect(review).toContainText("Dnes → Zítra");
    await expect(review).toContainText("Personal");
    await expect(review.locator(".proposalOrigin")).toContainText("Návrh Lumi");
    await expect(review.getByRole("button", { name: "Schválit změnu" })).toBeEnabled();
    expect(confirms).toBe(0);
    await review.getByRole("button", { name: "Schválit změnu" }).click();
    await expect(page.locator(".assistantMessages")).toContainText("Hotovo.");
    const result = page.locator(".assistantTurn").last().locator(".msg");
    await expect(result).toContainText("Hotovo.");
    await expect(result).toBeFocused(); // The review trigger is gone after approval.
    expect(confirms).toBe(1);
  });

  test("expired proposals allow inspection and rejection, never approval", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    let confirms = 0;
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      message: "Připravil jsem návrh.",
      proposal: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", summary: "Dokončit úkol", workspaceId: "personal", expiresAt: Date.now() - 10_000,
        changes: [], review: { target: "Úkol", workspace: "Personal", fields: [], related: [], sideEffects: [] } },
    }) }));
    await page.route("**/api/ai/actions", async (route) => {
      if (route.request().postDataJSON().action === "confirm") confirms++;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Zahozeno." }) });
    });
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await page.locator(".assistantComposer input").fill("Dokonči úkol");
    await page.locator(".assistantComposer input").press("Enter");
    await page.locator(".mobileProposalReview").click();
    const review = page.getByRole("dialog", { name: "Zkontrolovat návrh" });
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Schválit změnu" })).toBeDisabled();
    await expect(review.getByRole("alert")).toContainText("Platnost návrhu skončila");
    await expect(review.getByRole("button", { name: "Odmítnout" })).toBeEnabled();
    expect(confirms).toBe(0);
    await review.getByRole("button", { name: "Odmítnout" }).click();
    const result = page.locator(".assistantTurn").last().locator(".msg");
    await expect(result).toContainText("Návrh jsem zahodil");
    await expect(result).toBeFocused(); // Reject also removes its trigger.
    expect(confirms).toBe(0);
  });
});


test.describe("UI-08b keyboard return on dismissed review", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Escape closes the mobile review and returns focus to its still-present trigger", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    await page.route("**/api/ai", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      message: "Připravil jsem návrh.",
      proposal: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", summary: "Naplánovat úkol", workspaceId: "personal", expiresAt: Date.now() + 60_000,
        changes: [], review: { target: "Úkol", workspace: "Personal", fields: [], related: [], sideEffects: [] } },
    }) }));
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await page.locator(".assistantComposer input").fill("Naplánuj úkol");
    await page.locator(".assistantComposer input").press("Enter");
    const trigger = page.getByRole("button", { name: "Zkontrolovat návrh" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Zkontrolovat návrh" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Zavřít" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
