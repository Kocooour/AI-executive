import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitUntilQuiet } from "./helpers";

// Context: typed relations, and sources and evidence as records. Everything a scenario creates is named
// "e2e ..." and archived again afterwards, so the scenarios that read the Context view later (contrast,
// language) do not meet it.

async function openContext(page: Page) {
  await page.goto("/?view=Context");
  await expect(page.locator("#context-claim-editor")).toBeVisible();
  await waitUntilQuiet(page);
}

const editor = (page: Page) => page.locator("#context-claim-editor");
const card = (page: Page, text: string) => page.locator(".contextClaimCard", { hasText: text });
const historyBar = (page: Page) => page.locator(".contextHistoryBar");
const undoButton = (page: Page) => historyBar(page).getByRole("button", { name: /^Zpět/ });

type Json = Record<string, unknown>;
function api(page: Page, url: string, body: Json) {
  return page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), workspaceId: "personal", ...body }) });
    return { status: response.status, body: await response.json() };
  }, { url, body });
}
const newId = () => `e2e-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function seedPerson(page: Page, type: "person" | "organization", title: string) {
  const { body } = await api(page, "/api/context/subjects", { action: "create", id: newId(), expectedRevision: 0, type, title });
  return body.subject as { id: string; title: string };
}
async function seedClaim(page: Page, predicate: string, value: string) {
  const { body } = await api(page, "/api/context/claims", { action: "create", id: newId(), expectedRevision: 0, subject: { entityId: "workspace:personal" },
    predicate, literal: { type: "string", value }, freshness: "current", sensitivity: "normal" });
  return body.claim as { id: string; revision: number };
}
async function seedSource(page: Page, fields: Json) {
  const { body } = await api(page, "/api/context/sources", { action: "create", id: newId(), expectedRevision: 0, sensitivity: "normal", ...fields });
  return body.source as { id: string; revision: number };
}

// Archives whatever a scenario created: claims about e2e people and e2e claims first, then their evidence and sources, then the people.
test.afterEach(async ({ page }) => {
  await page.unroute("**/api/context/**").catch(() => undefined);
  if (!page.url().startsWith("http")) await page.goto("/");
  await page.evaluate(async () => {
    const post = (url: string, body: Record<string, unknown>) => fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), workspaceId: "personal", ...body }) });
    const get = async (url: string) => (await (await fetch(url, { cache: "no-store" })).json());
    const claims = (await get("/api/context/claims?workspaceId=personal")).claims as Array<{ id: string; predicate: string; revision: number;
      subject: { title: string }; target: { title: string } | null; evidenceItems: Array<{ id: string; revision: number }> }>;
    for (const claim of claims.filter((item) => item.predicate.startsWith("e2e.") || item.subject.title.startsWith("e2e ") || item.target?.title.startsWith("e2e "))) {
      for (const evidence of claim.evidenceItems) await post("/api/context/evidence", { action: "archive", id: evidence.id, expectedRevision: evidence.revision });
      const current = (await get("/api/context/claims?workspaceId=personal")).claims.find((item: { id: string }) => item.id === claim.id);
      await post("/api/context/claims", { action: "archive", id: claim.id, expectedRevision: current.revision });
    }
    const sources = (await get("/api/context/sources?workspaceId=personal")).sources as Array<{ id: string; revision: number; provider: string | null }>;
    for (const source of sources.filter((item) => item.provider?.startsWith("e2e"))) await post("/api/context/sources", { action: "archive", id: source.id, expectedRevision: source.revision });
    const subjects = (await get("/api/context/subjects?workspaceId=personal&includeArchived=true")).subjects as Array<{ id: string; title: string; revision: number; archivedAt: number | null }>;
    for (const subject of subjects.filter((item) => item.title.startsWith("e2e ") && !item.archivedAt)) await post("/api/context/subjects", { action: "archive", id: subject.id, expectedRevision: subject.revision });
  });
});

test("a works_for relationship is made through the registry select, an invalid pair is not offered, and the organization side reads the inverse", async ({ page }) => {
  await openContext(page);
  const person = await seedPerson(page, "person", "e2e Alex");
  const organization = await seedPerson(page, "organization", "e2e Acme");
  await openContext(page);

  await editor(page).getByLabel("O kom / čem").selectOption(person.id);
  await editor(page).getByTestId("claim-mode").selectOption("target");
  const target = editor(page).getByTestId("claim-target");
  const relation = editor(page).getByTestId("claim-relation");
  await expect(relation).toBeDisabled();
  await target.selectOption(organization.id);
  const offered = await relation.locator("option").allTextContents();
  expect(offered).toContain("pracuje pro");
  expect(offered).toContain("souvisí s");
  expect(offered).not.toContain("odpovídá za");
  expect(offered).not.toContain("přiřazeno");
  expect(offered).not.toContain("účastní se");

  // The other direction does not offer works_for at all.
  await editor(page).getByLabel("O kom / čem").selectOption(organization.id);
  await target.selectOption(person.id);
  expect(await relation.locator("option").allTextContents()).not.toContain("pracuje pro");

  await editor(page).getByLabel("O kom / čem").selectOption(person.id);
  await target.selectOption(organization.id);
  await expect(editor(page).getByRole("button", { name: "Uložit", exact: true })).toBeDisabled();
  await relation.selectOption({ label: "pracuje pro" });
  await expect(page.getByTestId("relation-preview")).toHaveText("e2e Alex — pracuje pro → e2e Acme");
  await editor(page).getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(editor(page).getByRole("status")).toContainText("Uloženo");

  const claim = card(page, "e2e Acme").filter({ hasText: "pracuje pro" });
  await expect(claim).toHaveCount(1);
  await expect(claim.locator(".claimInverse")).toHaveText("e2e Acme — zaměstnává: e2e Alex");
  // The organization's own entry reads from its side as well.
  const people = page.locator(".contextPeople article").filter({ has: page.locator("strong", { hasText: /^e2e Acme$/ }) });
  await people.locator("summary").click();
  await expect(people.locator(".contextPersonKnowledge")).toContainText("zaměstnává: e2e Alex");
  // A server that is asked for a pair the registry does not allow refuses it.
  const refused = await api(page, "/api/context/claims", { action: "create", id: newId(), expectedRevision: 0, subject: { subjectId: organization.id },
    predicate: "works_for", target: { subjectId: person.id }, freshness: "current", sensitivity: "normal" });
  expect(refused.status).toBe(400);
  expect(refused.body.code).toBe("invalid_relation");
});

test("evidence with a new source shows its coverage, is listed under the sources, and Undo removes it", async ({ page }) => {
  const predicate = "e2e.evidence.flow";
  await openContext(page);
  await seedClaim(page, predicate, "needs a source");
  await openContext(page);
  const claim = card(page, predicate);
  await expect(claim.locator(".claimMeta .coverageBadge")).toHaveText("bez zdroje");

  await claim.locator(".claimEvidence summary").click();
  await claim.getByRole("button", { name: "Přidat důkaz" }).click();
  const form = claim.locator(".contextEvidenceForm");
  await form.getByTestId("evidence-source-mode").selectOption("new");
  await form.getByLabel("Poskytovatel (například e-mail nebo dokument)").fill("e2e.mail");
  await form.getByLabel("Autor", { exact: true }).fill("Alex Sender");
  await form.getByLabel("Datum zdroje (RRRR-MM-DD)").fill("2026-05-01");
  await form.getByTestId("source-coverage").selectOption("excerpt");
  await form.getByLabel("Úryvek (nejvýše 500 znaků)").fill("The quoted sentence");
  await form.getByRole("button", { name: "Uložit důkaz" }).click();

  await expect(claim.locator(".claimMeta .coverageBadge")).toHaveText("doložený obsah");
  const evidence = claim.locator(".evidenceItem");
  await expect(evidence).toHaveCount(1);
  await expect(evidence).toContainText("The quoted sentence");
  await expect(evidence).toContainText("Alex Sender");
  await expect(evidence).toContainText("2026-05-01");
  await expect(evidence).toHaveAttribute("data-metadata-only", "false");
  // Adding evidence returned the claim to review, and the offer names the step.
  await expect(claim.locator(".claimState")).toHaveText("Ke kontrole");
  await expect(page.getByRole("button", { name: new RegExp(`^Zpět: Přidání důkazu k tvrzení ‚${predicate}‘`) })).toBeVisible();
  await expect(undoButton(page)).toContainText("Přidání důkazu k tvrzení");
  // The compact source list counts how many evidence items use it.
  const source = page.locator(".contextSourceCard", { hasText: "e2e.mail" });
  await expect(source).toContainText("Počet důkazů, které ho používají: 1");
  await expect(source.locator(".srcCoverageBadge-excerpt")).toBeVisible();

  await undoButton(page).click();
  await expect(claim.locator(".claimMeta .coverageBadge")).toHaveText("bez zdroje");
  await expect(claim.locator(".evidenceItem")).toHaveCount(0);
  await expect(source).toContainText("Počet důkazů, které ho používají: 0");

  // A source can be edited and the edit undone; a source nothing cites can be archived.
  await source.getByRole("button", { name: "Opravit" }).click();
  const sourceForm = page.locator(".contextSourceCard form");
  await sourceForm.getByLabel("Autor", { exact: true }).fill("Sam Sender");
  await sourceForm.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(source).toContainText("Sam Sender");
  await expect(page.getByRole("button", { name: /^Zpět: Úprava zdroje ‚/ })).toBeVisible();
  await undoButton(page).click();
  await expect(source).toContainText("Alex Sender");
  await source.getByRole("button", { name: "Archivovat" }).click();
  await expect(page.locator(".contextSourceCard", { hasText: "e2e.mail" })).toHaveCount(0);
});

test("a source known only by its metadata cannot take an excerpt: the form prevents it and the server answers 400", async ({ page }) => {
  const predicate = "e2e.evidence.metadata";
  await openContext(page);
  const seeded = await seedClaim(page, predicate, "metadata claim");
  const metadataSource = await seedSource(page, { provider: "e2e.calendar", coverage: "metadata" });
  await openContext(page);
  const claim = card(page, predicate);
  await claim.locator(".claimEvidence summary").click();
  await claim.getByRole("button", { name: "Přidat důkaz" }).click();
  const form = claim.locator(".contextEvidenceForm");
  await form.getByTestId("evidence-source-mode").selectOption("existing");
  await form.getByTestId("evidence-source-pick").selectOption(metadataSource.id);
  await expect(form.getByLabel("Úryvek (nejvýše 500 znaků)")).toBeDisabled();
  await expect(form.getByLabel("Místo ve zdroji")).toBeDisabled();
  await expect(form.getByRole("note")).toContainText("jen z metadat");
  // A reference without an excerpt is allowed, is marked, and does not make the claim a documented one.
  await form.getByRole("button", { name: "Uložit důkaz" }).click();
  await expect(claim.locator(".claimMeta .coverageBadge")).toHaveText("jen metadata");
  await expect(claim.locator(".evidenceItem")).toContainText("Jen metadata: nepodporuje obsahové tvrzení.");
  await expect(claim.locator(".evidenceItem")).toHaveAttribute("data-metadata-only", "true");

  // Bypassing the form: the server refuses an excerpt or a location on that source, and stores nothing.
  const claims = await page.evaluate(async () => (await (await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" })).json()).claims as Array<{ id: string; revision: number; evidenceItems: unknown[] }>);
  const stored = claims.find((item) => item.id === seeded.id)!;
  expect(stored.evidenceItems).toHaveLength(1);
  for (const fields of [{ excerpt: "A quote" }, { locator: "page 3" }]) {
    const refused = await api(page, "/api/context/evidence", { action: "add", id: newId(), claimId: seeded.id, expectedClaimRevision: stored.revision, expectedRevision: 0,
      sourceId: metadataSource.id, ...fields });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("metadata_only_source");
  }
  const after = await page.evaluate(async () => (await (await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" })).json()).claims as Array<{ id: string; revision: number; evidenceItems: unknown[] }>);
  expect(after.find((item) => item.id === seeded.id)).toMatchObject({ revision: stored.revision, evidenceItems: expect.any(Array) });
  expect(after.find((item) => item.id === seeded.id)!.evidenceItems).toHaveLength(1);
});

test("a relationship outside the registry is marked for review and can be edited to a registered one", async ({ page }) => {
  await openContext(page);
  const person = await seedPerson(page, "person", "e2e Robin");
  const organization = await seedPerson(page, "organization", "e2e Initech");
  const created = await api(page, "/api/context/claims", { action: "create", id: newId(), expectedRevision: 0, subject: { subjectId: person.id },
    predicate: "works_for", target: { subjectId: organization.id }, freshness: "current", sensitivity: "normal" });
  expect(created.status).toBe(201);
  // Written the way an older release stored it: a predicate the registry does not know.
  const database = new DatabaseSync(path.join(process.env.LUMI_E2E_RUN_DIR!, "data", "store.sqlite"));
  database.exec("PRAGMA busy_timeout = 5000");
  database.prepare("UPDATE context_claims SET predicate = 'owns' WHERE id = ?").run(created.body.claim.id);
  database.close();
  await openContext(page);
  const claim = card(page, "e2e Initech");
  await expect(claim.locator(".relationUnknown")).toHaveText("neznámý vztah — vyžaduje kontrolu");
  await expect(claim).toContainText("prověřit");
  expect(await page.evaluate(async () => ((await (await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" })).json()).claims as Array<{ predicate: string; relationStatus: string }>)
    .find((item) => item.predicate === "owns")?.relationStatus)).toBe("unregistered");

  await claim.getByRole("button", { name: "Opravit" }).click();
  await expect(editor(page).getByTestId("claim-relation")).toHaveValue("");
  await expect(editor(page).locator(".relationUnknown")).toContainText("neznámý vztah");
  await expect(editor(page).getByRole("button", { name: "Uložit", exact: true })).toBeDisabled();
  await editor(page).getByTestId("claim-relation").selectOption({ label: "pracuje pro" });
  await editor(page).getByRole("button", { name: "Uložit", exact: true }).click();
  await expect(editor(page).getByRole("status")).toContainText("Uloženo");
  await expect(card(page, "e2e Initech").locator(".relationUnknown")).toHaveCount(0);
  await expect(card(page, "e2e Initech")).toContainText("pracuje pro");
});

test("relations, evidence and sources fit a phone screen and their buttons are easy to hit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openContext(page);
  const predicate = "e2e.evidence.phone";
  const seeded = await seedClaim(page, predicate, "A long value that has to wrap on the width of a phone and must not stay one character per line");
  const source = await seedSource(page, { provider: "e2e.document", author: "An author with a rather long name that has to wrap", coverage: "body", locator: "https://example.test/a/very/long/path/that/keeps/going/and/going/and/going" });
  const added = await api(page, "/api/context/evidence", { action: "add", id: newId(), claimId: seeded.id, expectedClaimRevision: seeded.revision, expectedRevision: 0,
    sourceId: source.id, excerpt: "An excerpt long enough to wrap onto several lines on a narrow phone screen without any horizontal scrolling", stance: "supports" });
  expect(added.status).toBe(201);
  await openContext(page);
  const claim = card(page, predicate);
  await claim.locator(".claimEvidence summary").click();
  await claim.getByRole("button", { name: "Přidat důkaz" }).click();
  await claim.locator(".contextEvidenceForm").getByTestId("evidence-source-mode").selectOption("new");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const element of await page.locator(".contextClaimCard, .contextSourceCard, .contextEvidenceForm, .contextWorkspace > section, .evidenceItem").all()) {
    if (!(await element.isVisible())) continue;
    const box = (await element.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  for (const button of [claim.locator(".evidenceItem").getByRole("button", { name: /^Archivovat důkaz/ }), claim.locator(".contextEvidenceForm").getByRole("button", { name: "Uložit důkaz" }),
    claim.locator(".contextEvidenceForm").getByRole("button", { name: "Zrušit" }), page.locator(".contextSourceCard", { hasText: "e2e.document" }).getByRole("button", { name: "Opravit" }),
    page.locator(".contextSourceCard", { hasText: "e2e.document" }).getByRole("button", { name: "Archivovat" })]) {
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  }
  // The relation select and the preview line fit too.
  const person = await seedPerson(page, "person", "e2e Phone Person");
  const organization = await seedPerson(page, "organization", "e2e Phone Organization With A Rather Long Name");
  await openContext(page);
  await editor(page).getByLabel("O kom / čem").selectOption(person.id);
  await editor(page).getByTestId("claim-mode").selectOption("target");
  await editor(page).getByTestId("claim-target").selectOption(organization.id);
  await editor(page).getByTestId("claim-relation").selectOption({ label: "pracuje pro" });
  const preview = (await page.getByTestId("relation-preview").boundingBox())!;
  expect(preview.x + preview.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
