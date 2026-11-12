import { test, expect } from "./fixtures";
import { waitUntilSynced, serverEntities } from "./helpers";

test.describe("mobile proposal approval", () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });

  test("shows real Inbox removal on a same-date reschedule before approval", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    const title = `Kontrolní úkol ${Date.now()}`;
    // Seed a real task whose date is already tomorrow, but which still belongs to Inbox.
    // The AI update keeps 'when' unchanged and changes inbox true -> false.
    const id = await page.evaluate(async (taskTitle) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date()).map((part) => [part.type, part.value]));
      const tomorrow = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1, 12)).toISOString().slice(0, 10);
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const now = Date.now();
      const taskId = `e2e-approval-placement-${now}`;
      const response = await fetch("/api/store", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
          entities: [...snapshot.entities, {
            id: taskId, type: "task", title: taskTitle, status: "open", workspaceId: "personal",
            properties: { inbox: true, today: false, when: tomorrow }, createdAt: now, updatedAt: now,
          }],
          relations: snapshot.relations, deletedIds: [], revivedIds: [],
        }),
      });
      if (!response.ok) throw new Error(`Cannot seed Inbox task: ${response.status}`);
      return taskId;
    }, title);
    await page.reload();
    await waitUntilSynced(page);
    await expect.poll(async () => (await serverEntities(page)).find((item) => item.id === id)?.properties?.inbox).toBe(true);

    // Do not mock /api/ai or /api/ai/actions: exercise the real proposal generator, confirmation, and SQLite.
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await page.locator(".assistantComposer input").fill(`Přesuň ${title} na zítra`);
    const proposalResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/ai") && response.request().method() === "POST");
    await page.locator(".assistantComposer input").press("Enter");
    const proposal = (await (await proposalResponse).json()).proposal;
    expect(proposal?.review?.fields).toContainEqual({ label: "Inbox", before: "true", after: "false" });
    expect(proposal.review.fields.some((field: { label: string }) => field.label === "When")).toBe(false);

    await page.getByRole("button", { name: "Zkontrolovat návrh" }).click();
    const sheet = page.getByRole("dialog", { name: "Zkontrolovat návrh" });
    await expect(sheet.locator(".proposalBeforeAfter p", { hasText: "Doručené" })).toContainText("Ano → Ne");
    await expect(sheet).not.toContainText("Planning decision");
    await expect.poll(async () => (await serverEntities(page)).find((item) => item.id === id)?.properties?.inbox).toBe(true);

    await sheet.getByRole("button", { name: "Schválit změnu" }).click();
    await expect.poll(async () => (await serverEntities(page)).find((item) => item.id === id)?.properties?.inbox, { timeout: 20_000 }).toBe(false);
  });

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

  test("capture scope stays local, but switching the active workspace clears proposals and late replies", async ({ page }) => {
    await page.goto("/");
    await waitUntilSynced(page);
    const otherWorkspaceId = await page.evaluate(async () => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const workspaceId = `approval-other-${Date.now()}`;
      const now = Date.now();
      const response = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: [...snapshot.entities, { id: `workspace:${workspaceId}`, type: "workspace", title: "Other", status: "active", workspaceId, properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now }],
        relations: snapshot.relations, deletedIds: [], revivedIds: [],
      }) });
      if (!response.ok) throw new Error(`Could not add test workspace: ${response.status}`);
      return workspaceId;
    });
    await page.reload();
    await waitUntilSynced(page);
    await page.getByRole("button", { name: "Přepnout workspace" }).click();
    await page.locator('.mobileWorkspaceMenu button[data-workspace-id="all"]').click();

    const proposal = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", summary: "Přesunout Tajný úkol", workspaceId: "personal", expiresAt: Date.now() + 300_000,
      changes: [{ label: "Workspace", value: "Personal" }], review: { target: "Tajný úkol", workspace: "Personal",
        fields: [{ label: "When", before: "Dnes", after: "Zítra" }], related: ["Tajný projekt"], sideEffects: ["approvalTaskSync"] } };
    let releaseLateReply: (() => void) | undefined;
    let requestCount = 0;
    await page.route("**/api/ai", async (route) => {
      requestCount++;
      if (requestCount === 2) await new Promise<void>((resolve) => { releaseLateReply = resolve; });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Připravil jsem návrh.", proposal }) });
    });
    const ask = async (text: string) => {
      await page.getByRole("button", { name: "Zeptat se AI" }).click();
      await page.locator(".assistantComposer input").fill(text);
      await page.locator(".assistantComposer input").press("Enter");
    };
    // #248: the Quick Capture destination is local to the draft and must not
    // invalidate an unrelated AI proposal or change the global write workspace.
    const chooseCaptureDestination = async (id: string) => {
      await page.locator(".assistantHead").getByRole("button", { name: "Zavřít" }).click();
      await page.locator(".mobileCaptureButton").click();
      const capture = page.getByRole("dialog", { name: "Rychlé zadání" });
      await capture.getByLabel("Workspace").selectOption(id);
      await capture.getByRole("button", { name: "Zrušit" }).click();
    };
    // Active scope switching really does invalidate proposal context and late responses.
    const switchActiveWorkspace = async (id: string) => {
      await page.locator(".assistantHead").getByRole("button", { name: "Zavřít" }).click();
      await page.getByRole("button", { name: "Přepnout workspace" }).click();
      await page.locator(`.mobileWorkspaceMenu button[data-workspace-id="${id}"]`).click();
      await page.getByRole("button", { name: "Přepnout workspace" }).click();
      await page.locator('.mobileWorkspaceMenu button[data-workspace-id="all"]').click();
    };

    await ask("Přesuň Tajný úkol");
    await expect(page.getByRole("button", { name: "Zkontrolovat návrh" })).toBeVisible();
    await chooseCaptureDestination(otherWorkspaceId);
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    // The original proposal is still readable because only capture changed.
    await expect(page.getByRole("button", { name: "Zkontrolovat návrh" })).toBeVisible();
    await switchActiveWorkspace(otherWorkspaceId);
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await expect(page.locator(".assistantMessages")).not.toContainText("Tajný úkol");
    await expect(page.locator(".assistantMessages")).not.toContainText("Tajný projekt");
    await page.locator(".assistantHead").getByRole("button", { name: "Zavřít" }).click();

    await ask("Připrav návrh v Other");
    await expect.poll(() => requestCount).toBe(2);
    await switchActiveWorkspace("personal");
    releaseLateReply?.();
    await page.getByRole("button", { name: "Zeptat se AI" }).click();
    await expect(page.locator(".assistantMessages")).not.toContainText("Tajný úkol");
    await expect(page.locator(".assistantMessages")).not.toContainText("Tajný projekt");
  });
});
