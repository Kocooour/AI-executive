import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitUntilQuiet } from "./helpers";

// Context claims: a command that is retried after a lost response is one command, a response
// belongs to the claim it was sent for, and the three sensitivity levels decide what AI may see.
// Each scenario is its own client address (see fixtures), so the write limit is not shared.

type ServerClaim = { id: string; predicate: string; revision: number; reviewStatus: string; sensitivity: string; eligibleForAI: boolean; literal: { value: string } | null };

async function openContext(page: Page) {
  await page.goto("/?view=Context");
  await expect(page.locator("#context-claim-editor")).toBeVisible();
  await waitUntilQuiet(page);
}

function serverClaims(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" });
    return ((await response.json()).claims || []) as ServerClaim[];
  });
}

// A claim created straight through the API, so a scenario starts from known claims.
function seedClaim(page: Page, predicate: string, value: string, sensitivity = "normal") {
  return page.evaluate(async (claim) => {
    const response = await fetch("/api/context/claims", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: crypto.randomUUID(),
        expectedRevision: 0, subject: { entityId: "workspace:personal" }, predicate: claim.predicate, literal: { type: "string", value: claim.value },
        freshness: "current", sensitivity: claim.sensitivity }) });
    return { status: response.status, claim: (await response.json()).claim as ServerClaim };
  }, { predicate, value, sensitivity });
}

// The scenarios after this file (contrast, language) read every visible text of the Context view,
// so the claims made here are archived again and no longer listed.
test.afterEach(async ({ page }) => {
  await page.unroute("**/api/context/claims").catch(() => undefined);
  if (!page.url().startsWith("http")) await page.goto("/");
  await page.evaluate(async () => {
    const response = await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" });
    const claims = ((await response.json()).claims || []) as Array<{ id: string; predicate: string; revision: number }>;
    for (const claim of claims.filter((item) => item.predicate.startsWith("e2e."))) {
      await fetch("/api/context/claims", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "archive", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: claim.id, expectedRevision: claim.revision }) });
    }
  });
});

function editor(page: Page) {
  return page.locator("#context-claim-editor");
}
const valueInput = (page: Page) => editor(page).getByLabel("Hodnota", { exact: true });
const saveButton = (page: Page) => editor(page).getByRole("button", { name: "Uložit", exact: true });
const card = (page: Page, predicate: string) => page.locator(".contextClaimCard", { hasText: predicate });

async function fillDraft(page: Page, predicate: string, value: string) {
  await editor(page).getByLabel("O kom / čem").selectOption("workspace:personal");
  await editor(page).getByLabel("Vztah nebo vlastnost").fill(predicate);
  await valueInput(page).fill(value);
}

test("a save whose response is lost is retried without creating a second claim", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.lost.response";
  const sent: Array<{ idempotencyKey: string; id: string }> = [];
  let posts = 0;
  await page.route("**/api/context/claims", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    sent.push(JSON.parse(route.request().postData() || "{}"));
    if (posts === 1) {
      // The server handles the request and saves the claim; the answer never reaches the page.
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await fillDraft(page, predicate, "první pokus");
  await saveButton(page).click();
  await expect(editor(page).getByRole("status")).toContainText("Spojení se přerušilo");
  // The draft is still there and the claim already exists on the server once.
  await expect(valueInput(page)).toHaveValue("první pokus");
  expect((await serverClaims(page)).filter((claim) => claim.predicate === predicate)).toHaveLength(1);
  await saveButton(page).click();
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo. Nové tvrzení čeká na kontrolu.");
  expect(posts).toBe(2);
  expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
  expect(sent[1].id).toBe(sent[0].id);
  expect((await serverClaims(page)).filter((claim) => claim.predicate === predicate)).toHaveLength(1);
  await expect(page.locator(".contextClaimCard", { hasText: predicate })).toHaveCount(1);
  // The editor is empty again: the next claim is a new command.
  await expect(valueInput(page)).toHaveValue("");
});

test("a saved claim stays saved when the list cannot be loaded afterwards", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.refresh.fails";
  let posts = 0;
  let failNextList = false;
  await page.route("**/api/context/claims**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posts += 1;
      const response = await route.fetch();
      failNextList = true;
      return route.fulfill({ response });
    }
    if (failNextList) {
      // The claim was saved; only the list that follows cannot be loaded.
      failNextList = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
    }
    return route.continue();
  });
  await fillDraft(page, predicate, "uloženo jednou");
  await saveButton(page).click();
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo, ale seznam se nepodařilo znovu načíst. Aktuální stav ukáže Obnovit tvrzení nebo nové načtení stránky.");
  // The editor no longer holds the saved draft, so another save cannot repeat the create.
  await expect(valueInput(page)).toHaveValue("");
  expect(posts).toBe(1);
  await page.unroute("**/api/context/claims**");
  expect((await serverClaims(page)).filter((claim) => claim.predicate === predicate)).toHaveLength(1);
  await page.getByRole("button", { name: "Obnovit tvrzení" }).click();
  await expect(card(page, predicate)).toHaveCount(1);
});

test("a late answer for one claim does not overwrite the editor that now shows another", async ({ page }) => {
  await openContext(page);
  await seedClaim(page, "e2e.switch.a", "hodnota A");
  await seedClaim(page, "e2e.switch.b", "hodnota B");
  await openContext(page);
  await page.route("**/api/context/claims", async (route) => {
    if (route.request().method() !== "POST" || !route.request().postData()?.includes('"action":"update"')) return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await card(page, "e2e.switch.a").getByRole("button", { name: "Opravit" }).click();
  await expect(valueInput(page)).toHaveValue("hodnota A");
  await valueInput(page).fill("hodnota A změněná");
  await saveButton(page).click();
  // While A is being saved the owner opens B.
  await card(page, "e2e.switch.b").getByRole("button", { name: "Opravit" }).click();
  await expect(valueInput(page)).toHaveValue("hodnota B");
  // A's answer arrives; the list shows it, the editor keeps showing B untouched.
  await expect(card(page, "e2e.switch.a")).toContainText("hodnota A změněná", { timeout: 15_000 });
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo.");
  await expect(editor(page).getByRole("heading", { name: "Upravit tvrzení" })).toBeVisible();
  await expect(valueInput(page)).toHaveValue("hodnota B");
  await expect(editor(page).getByLabel("Vztah nebo vlastnost")).toHaveValue("e2e.switch.b");
  const claims = await serverClaims(page);
  expect(claims.find((claim) => claim.predicate === "e2e.switch.a")?.literal?.value).toBe("hodnota A změněná");
  expect(claims.find((claim) => claim.predicate === "e2e.switch.b")?.literal?.value).toBe("hodnota B");
});

test("typing again while a save is in flight keeps the newer text and continues from the saved revision", async ({ page }) => {
  await openContext(page);
  await seedClaim(page, "e2e.overlap", "původní");
  await openContext(page);
  await page.route("**/api/context/claims", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ response });
  });
  await card(page, "e2e.overlap").getByRole("button", { name: "Opravit" }).click();
  await valueInput(page).fill("první změna");
  await saveButton(page).click();
  await valueInput(page).fill("druhá změna");
  await expect(card(page, "e2e.overlap")).toContainText("první změna", { timeout: 15_000 });
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo.");
  await expect(valueInput(page)).toHaveValue("druhá změna");
  // The newer text saves on top of the saved revision, without a conflict.
  await saveButton(page).click();
  await expect(card(page, "e2e.overlap")).toContainText("druhá změna", { timeout: 15_000 });
  await expect(editor(page).getByRole("status")).not.toContainText("Konflikt");
});

test("changing the subject while a new claim is saved keeps the subject it was saved with", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.subject.inflight";
  await page.route("**/api/context/claims", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ response });
  });
  await fillDraft(page, predicate, "hodnota");
  await saveButton(page).click();
  const subject = editor(page).getByLabel("O kom / čem");
  const other = await subject.locator("option").evaluateAll((options) =>
    (options as HTMLOptionElement[]).map((option) => option.value).find((value) => value && value !== "workspace:personal"));
  expect(other).toBeTruthy();
  await subject.selectOption(other!);
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo u původního subjektu. Subjekt uloženého tvrzení nejde změnit; pro jiný vytvořte nové tvrzení.", { timeout: 15_000 });
  // The editor shows what the server stores, and the subject cannot be changed on the saved claim.
  await expect(subject).toHaveValue("workspace:personal");
  await expect(subject).toBeDisabled();
  const saved = (await serverClaims(page)).filter((claim) => claim.predicate === predicate);
  expect(saved).toHaveLength(1);
});

test("sensitivity has three levels and only normal claims are eligible for AI", async ({ page }) => {
  await openContext(page);
  const select = editor(page).getByLabel("Citlivost");
  await expect(select.locator("option")).toHaveText(["Běžné", "Důvěrné", "Omezené"]);
  await expect(select).toHaveValue("normal");
  // A confidential claim saved through the editor.
  await fillDraft(page, "e2e.confidential", "jen pro mě");
  await select.selectOption("confidential");
  await saveButton(page).click();
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo. Nové tvrzení čeká na kontrolu.");
  await seedClaim(page, "e2e.restricted", "omezené", "restricted");
  await seedClaim(page, "e2e.normal", "běžné", "normal");
  // The previous clients' two-level value is still accepted and stored as confidential.
  await seedClaim(page, "e2e.legacy", "starý klient", "sensitive");
  for (const predicate of ["e2e.confidential", "e2e.restricted", "e2e.normal", "e2e.legacy"]) {
    const claim = (await serverClaims(page)).find((item) => item.predicate === predicate)!;
    const reviewed = await page.evaluate(async (target) => {
      const response = await fetch("/api/context/claims", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "review", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: target.id,
          expectedRevision: target.revision, decision: "confirmed" }) });
      return response.status;
    }, claim);
    expect(reviewed).toBe(200);
  }
  const claims = await serverClaims(page);
  const by = (predicate: string) => claims.find((claim) => claim.predicate === predicate)!;
  expect([by("e2e.confidential").sensitivity, by("e2e.restricted").sensitivity, by("e2e.normal").sensitivity, by("e2e.legacy").sensitivity])
    .toEqual(["confidential", "restricted", "normal", "confidential"]);
  expect([by("e2e.confidential").eligibleForAI, by("e2e.restricted").eligibleForAI, by("e2e.legacy").eligibleForAI, by("e2e.normal").eligibleForAI])
    .toEqual([false, false, false, true]);
  await openContext(page);
  await expect(card(page, "e2e.confidential")).toContainText("důvěrné");
  await expect(card(page, "e2e.restricted")).toContainText("omezené");
});

test("a claim can be confirmed, rejected and returned to review", async ({ page }) => {
  await openContext(page);
  await seedClaim(page, "e2e.review.cycle", "kolečko");
  await openContext(page);
  const claim = card(page, "e2e.review.cycle");
  const state = (text: string) => expect(claim.locator(".claimState")).toHaveText(text);
  await state("Ke kontrole");
  await claim.getByRole("button", { name: "Potvrdit" }).click();
  await state("Potvrzeno");
  await claim.getByRole("button", { name: "Odmítnout" }).click();
  await state("Odmítnuto");
  await claim.getByRole("button", { name: "Vrátit ke kontrole" }).click();
  await state("Ke kontrole");
  await claim.getByRole("button", { name: "Potvrdit" }).click();
  await state("Potvrzeno");
  expect((await serverClaims(page)).find((item) => item.predicate === "e2e.review.cycle")?.revision).toBe(5);
  // The history names each decision, not just "reviewed".
  await claim.getByRole("button", { name: "Historie" }).click();
  const history = claim.locator(".contextSubjectHistory li");
  await expect(history).toHaveCount(5);
  await expect(history.filter({ hasText: "Vráceno ke kontrole" })).toHaveCount(1);
  await expect(history.filter({ hasText: "Odmítnuto" })).toHaveCount(1);
  await expect(history.filter({ hasText: "Potvrzeno" })).toHaveCount(2);
});

test("claim cards stack and fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openContext(page);
  await seedClaim(page, "e2e.phone.layout", "Dlouhá hodnota, která se musí zalomit na šířku telefonu a nesmí zůstat jeden znak na řádek");
  await openContext(page);
  const claim = card(page, "e2e.phone.layout");
  await claim.getByRole("button", { name: "Historie" }).click();
  await expect(claim.locator(".contextSubjectHistory li")).toHaveCount(1);
  const box = (await claim.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect((await claim.locator("p").first().boundingBox())!.width).toBeGreaterThan(200);
  const history = (await claim.locator(".contextSubjectHistory li").first().boundingBox())!;
  expect(history.width).toBeGreaterThan(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const section of await page.locator(".contextWorkspace > section").all()) {
    const sectionBox = (await section.boundingBox())!;
    expect(sectionBox.x + sectionBox.width).toBeLessThanOrEqual(390);
  }
});
