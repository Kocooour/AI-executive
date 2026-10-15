import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  await page.unroute("**/api/context/history?*").catch(() => undefined);
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

test("a rename whose response is lost is replayed even after an unrelated field changes", async ({ page }) => {
  await openContext(page);
  const original = `E2E person ${Date.now()}`;
  const renamed = `${original} renamed`;
  const seeded = await page.evaluate(async (title) => {
    const response = await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: crypto.randomUUID(),
        expectedRevision: 0, type: "person", title }) });
    return (await response.json()).subject as { id: string };
  }, original);
  await openContext(page);
  const sent: Array<{ idempotencyKey: string }> = [];
  let posts = 0;
  await page.route("**/api/context/subjects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    sent.push(JSON.parse(route.request().postData() || "{}"));
    if (posts === 1) { await route.fetch(); await route.abort("connectionreset"); return; }
    await route.continue();
  });
  const people = page.locator(".contextPeople");
  const row = people.locator("article", { hasText: original });
  await row.getByRole("button", { name: "Přejmenovat" }).click();
  await people.getByLabel("Upravit jméno").fill(renamed);
  await people.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(people.getByRole("status")).toContainText("Spojení se přerušilo");
  // The type of a new person has nothing to do with this rename.
  await people.getByLabel("Typ").selectOption("organization");
  await people.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(people.locator("article", { hasText: renamed })).toHaveCount(1);
  expect(posts).toBe(2);
  expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
  await page.unroute("**/api/context/subjects");
  await page.evaluate(async (id) => {
    const list = await (await fetch("/api/context/subjects?workspaceId=personal&includeArchived=true", { cache: "no-store" })).json();
    const subject = (list.subjects as Array<{ id: string; revision: number }>).find((item) => item.id === id)!;
    await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id, expectedRevision: subject.revision }) });
  }, seeded.id);
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

// Undo and Redo of the Context (claims, people, organizations): durable, and a reversal is a new revision.
const historyBar = (page: Page) => page.locator(".contextHistoryBar");
const undoButton = (page: Page) => historyBar(page).getByRole("button", { name: /^Zpět/ });
const redoButton = (page: Page) => historyBar(page).getByRole("button", { name: /^Znovu/ });

async function saveNewClaim(page: Page, predicate: string, value: string) {
  await fillDraft(page, predicate, value);
  await saveButton(page).click();
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo. Nové tvrzení čeká na kontrolu.");
}

async function editClaim(page: Page, predicate: string, value: string) {
  await card(page, predicate).getByRole("button", { name: "Opravit" }).click();
  await valueInput(page).fill(value);
  await saveButton(page).click();
  await expect(card(page, predicate)).toContainText(value);
}

const serverValue = async (page: Page, predicate: string) => (await serverClaims(page)).find((claim) => claim.predicate === predicate);

test("claim steps are undone twice and redone once, and the bar names each step", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.history.walk";
  await expect(undoButton(page)).toBeVisible();
  await saveNewClaim(page, predicate, "first value");
  // The saved edit offers a concrete Undo right next to its confirmation, and the bar says the same.
  await expect(editor(page).getByRole("button", { name: new RegExp(`^Zpět: Přidání tvrzení .*${predicate}`) })).toBeVisible();
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
  await expect(undoButton(page)).toContainText(predicate);
  await editClaim(page, predicate, "second value");
  await editClaim(page, predicate, "third value");
  await expect(undoButton(page)).toContainText("Úprava tvrzení");
  await expect(redoButton(page)).toBeDisabled();
  await expect(redoButton(page)).toContainText("Není co obnovit");
  expect((await serverValue(page, predicate))?.revision).toBe(3);

  await undoButton(page).click();
  await expect(card(page, predicate)).toContainText("second value");
  await expect(historyBar(page).getByRole("status")).toContainText("Vráceno zpět: Úprava tvrzení");
  await undoButton(page).click();
  await expect(card(page, predicate)).toContainText("first value");
  await expect(redoButton(page)).toContainText("Úprava tvrzení");
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
  await redoButton(page).click();
  await expect(card(page, predicate)).toContainText("second value");
  await expect(card(page, predicate)).not.toContainText("third value");
  // Every reversal is a new revision: 1 create, 2 and 3 edits, 4 and 5 undos, 6 redo.
  const claim = await serverValue(page, predicate);
  expect(claim?.revision).toBe(6);
  expect(claim?.literal?.value).toBe("second value");
  // The undone third edit is still redoable; a new edit would end that.
  await expect(redoButton(page)).toContainText("Úprava tvrzení");
  await editClaim(page, predicate, "fourth value");
  await expect(redoButton(page)).toBeDisabled();
});

test("Undo survives a reload and the editor follows the undone claim", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.history.reload";
  await saveNewClaim(page, predicate, "kept value");
  await editClaim(page, predicate, "changed value");
  await undoButton(page).click();
  await expect(card(page, predicate)).toContainText("kept value");
  await page.reload();
  await expect(editor(page)).toBeVisible();
  await waitUntilQuiet(page);
  // Nothing is held in the page: both stacks come from the server.
  await expect(redoButton(page)).toContainText("Úprava tvrzení");
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
  await redoButton(page).click();
  await expect(card(page, predicate)).toContainText("changed value");
  // With the claim open in the editor, Undo of its last edit brings the editor to the new revision.
  await card(page, predicate).getByRole("button", { name: "Opravit" }).click();
  await expect(valueInput(page)).toHaveValue("changed value");
  await undoButton(page).click();
  await expect(valueInput(page)).toHaveValue("kept value");
  // Undoing the create archives the claim, and the editor lets go of it.
  await undoButton(page).click();
  await expect(card(page, predicate)).toHaveCount(0);
  await expect(editor(page).getByRole("heading", { name: "Přidat tvrzení" })).toBeVisible();
  expect((await serverValue(page, predicate))).toBeUndefined();
});

test("an Undo that no longer matches the history is refused and nothing is changed", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.history.stale";
  await saveNewClaim(page, predicate, "mine");
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
  // Another tab (or device) edits the same claim; this page still shows the older step. (A page that
  // regains focus would refresh the bar by itself, so the refresh is held back here.)
  const staleBar = await page.evaluate(() => fetch("/api/context/history?workspaceId=personal", { cache: "no-store" }).then((response) => response.text()));
  await page.route("**/api/context/history?*", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: staleBar }) : route.continue());
  const other = await page.context().newPage();
  await other.goto("/?view=Context");
  await expect(other.locator("#context-claim-editor")).toBeVisible();
  const edited = await other.evaluate(async (target) => {
    const list = await (await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" })).json();
    const claim = (list.claims as Array<{ id: string; predicate: string; revision: number }>).find((item) => item.predicate === target)!;
    const response = await fetch("/api/context/claims", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: claim.id,
        expectedRevision: claim.revision, predicate: target, literal: { type: "string", value: "from the other tab" },
        freshness: "current", sensitivity: "normal" }) });
    return response.status;
  }, predicate);
  expect(edited).toBe(200);
  await other.close();
  const before = await serverValue(page, predicate);
  await undoButton(page).click();
  await expect(historyBar(page).getByRole("status")).toContainText("Historie se mezitím změnila");
  await expect(historyBar(page).getByRole("status")).toContainText("nic nevrátilo");
  const after = await serverValue(page, predicate);
  expect(after?.revision).toBe(before?.revision);
  expect(after?.literal?.value).toBe("from the other tab");
  // Once the page reads the history again, the bar shows the step that really is on top, and that one can be undone.
  await page.unroute("**/api/context/history?*");
  await page.getByRole("button", { name: "Obnovit tvrzení" }).click();
  await expect(undoButton(page)).toContainText("Úprava tvrzení");
  await undoButton(page).click();
  await expect(card(page, predicate)).toContainText("mine");
});

test("Ctrl+Z undoes outside text fields and leaves the browser's own undo inside them", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.history.keys";
  await saveNewClaim(page, predicate, "typed once");
  await editClaim(page, predicate, "typed twice");
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/context/history")) posts.push(request.postData() || ""); });
  // Inside the value field the shortcut belongs to the field.
  await card(page, predicate).getByRole("button", { name: "Opravit" }).click();
  await valueInput(page).click();
  await page.keyboard.type(" and more");
  await page.keyboard.press("Control+KeyZ");
  await page.keyboard.press("Control+Shift+KeyZ");
  await page.waitForTimeout(400);
  expect(posts).toHaveLength(0);
  await expect(card(page, predicate)).toContainText("typed twice");
  // Outside any field it is the context Undo/Redo.
  await page.getByRole("heading", { name: "Co Lumi ví" }).click();
  await page.keyboard.press("Control+KeyZ");
  await expect(card(page, predicate)).toContainText("typed once");
  expect(posts).toHaveLength(1);
  await page.keyboard.press("Control+Shift+KeyZ");
  await expect(card(page, predicate)).toContainText("typed twice");
  expect(posts).toHaveLength(2);
  expect((await serverValue(page, predicate))?.revision).toBe(4);
});

test("the history bar fits a phone screen and its buttons are easy to hit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openContext(page);
  const predicate = "e2e.history.a_long_relationship_name_that_has_to_wrap_on_a_phone_screen";
  await seedClaim(page, predicate, "x");
  await openContext(page);
  await expect(undoButton(page)).toContainText(predicate);
  for (const button of [undoButton(page), redoButton(page)]) {
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await undoButton(page).tap().catch(() => undoButton(page).click());
  await expect(card(page, predicate)).toHaveCount(0);
  await expect(redoButton(page)).toContainText(predicate);
});

test("a save that changed nothing offers no Undo for an older step", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.history.noop";
  await saveNewClaim(page, predicate, "unchanged");
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
  // Saving the claim again without any change records no step, so nothing is offered.
  await card(page, predicate).getByRole("button", { name: "Opravit" }).click();
  await saveButton(page).click();
  await expect(editor(page).getByRole("status")).toHaveText("Uloženo.");
  await expect(editor(page).getByRole("button", { name: /^Zpět:/ })).toHaveCount(0);
  expect((await serverValue(page, predicate))?.revision).toBe(1);
  // The same for a person renamed to the name they already have.
  const title = `E2E noop ${Date.now()}`;
  const seeded = await page.evaluate(async (name) => {
    const response = await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: crypto.randomUUID(),
        expectedRevision: 0, type: "person", title: name }) });
    return (await response.json()).subject as { id: string };
  }, title);
  await openContext(page);
  const people = page.locator(".contextPeople");
  await people.locator("article", { hasText: title }).getByRole("button", { name: "Přejmenovat" }).click();
  await people.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(people.getByRole("status")).toHaveText("Uloženo.");
  await expect(people.getByRole("button", { name: /^Zpět:/ })).toHaveCount(0);
  // A real change does offer it, naming the step.
  await people.locator("article", { hasText: title }).getByRole("button", { name: "Přejmenovat" }).click();
  await people.getByLabel("Upravit jméno").fill(`${title} B`);
  await people.getByRole("button", { name: "Uložit", exact: true }).click();
  const offer = people.getByRole("button", { name: /^Zpět: Přejmenování osoby/ });
  await expect(offer).toBeVisible();
  expect((await offer.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await offer.click();
  await expect(people.locator("article", { hasText: title }).first()).toBeVisible();
  await expect(historyBar(page).getByRole("status")).toContainText(`Vráceno zpět: Přejmenování osoby ${title} → ${title} B`);
  await expect(people.getByRole("status")).toHaveCount(0);
  await page.evaluate(async (id) => {
    const list = await (await fetch("/api/context/subjects?workspaceId=personal&includeArchived=true", { cache: "no-store" })).json();
    const subject = (list.subjects as Array<{ id: string; revision: number }>).find((item) => item.id === id)!;
    await fetch("/api/context/subjects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id, expectedRevision: subject.revision }) });
  }, seeded.id);
});

test("a step that is refused for good can be skipped, which changes no data and reaches the older step", async ({ page }) => {
  await openContext(page);
  const predicate = "e2e.history.skip";
  await saveNewClaim(page, predicate, "older value");
  await editClaim(page, predicate, "newer value");
  // A real refusal: the claim moves on outside the history (another writer), so its newest step can never be undone.
  const database = new DatabaseSync(path.join(process.env.LUMI_E2E_RUN_DIR!, "data", "store.sqlite"));
  database.exec("PRAGMA busy_timeout = 5000");
  database.prepare("UPDATE context_claims SET revision = revision + 1 WHERE predicate = ? AND workspace_id = 'personal'").run(predicate);
  database.close();
  const before = await serverValue(page, predicate);
  await undoButton(page).click();
  await expect(historyBar(page).getByRole("status")).toContainText("Nevráceno");
  const skip = historyBar(page).getByRole("button", { name: "Přeskočit tento krok" });
  await expect(skip).toBeVisible();
  await expect(historyBar(page)).toContainText("data se nijak nezmění");
  await skip.click();
  await expect(historyBar(page).getByRole("status")).toContainText("Přeskočeno: Úprava tvrzení");
  await expect(skip).toHaveCount(0);
  // Nothing changed in the claim; the older step (the create) is the top now.
  const after = await serverValue(page, predicate);
  expect(after?.revision).toBe(before?.revision);
  expect(after?.literal?.value).toBe("newer value");
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
  await card(page, predicate).getByRole("button", { name: "Historie" }).click();
  await expect(card(page, predicate).locator(".contextSubjectHistory li").first()).toContainText("Přeskočeno: Úprava tvrzení");
  // It stays skipped after a reload.
  await page.reload();
  await expect(editor(page)).toBeVisible();
  await expect(undoButton(page)).toContainText("Přidání tvrzení");
});

test("the Undo offer is a real button that is not covered on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openContext(page);
  await saveNewClaim(page, "e2e.history.offer", "phone");
  const offer = editor(page).getByRole("button", { name: /^Zpět: Přidání tvrzení/ });
  await offer.scrollIntoViewIfNeeded();
  const box = (await offer.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const covered = await offer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !(hit === element || element.contains(hit));
  });
  expect(covered).toBe(false);
  expect(await offer.evaluate((element) => getComputedStyle(element).borderTopWidth)).not.toBe("0px");
});
