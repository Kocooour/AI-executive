import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { confirmDialog, serverEntities, waitUntilSynced } from "./helpers";

// Backups, restore, export and import in Settings → Data and backups. A restore returns everything in scope to the
// backup: records, Context with its Undo steps, sources, and note versions. These scenarios change the shared
// instance, so each puts back what it added (the scenarios after this file audit every visible text).

const stamp = Date.now();
const marker = `e2e.backup.${stamp}`;

type Claim = { id: string; predicate: string; revision: number; literal: { value: string } | null };

async function setStore(page: Page, add: Array<Record<string, unknown>>, removeIds: string[] = [], replace: Record<string, Record<string, unknown>> = {}) {
  const status = await page.evaluate(async ([added, removed, replaced]) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    const kept = snapshot.entities.filter((entity: { id: string }) => !(removed as string[]).includes(entity.id)).map((entity: { id: string }) => (replaced as Record<string, object>)[entity.id] ?? entity);
    const entities = [...kept, ...(added as object[]).map((entity) => ({ createdAt: now, updatedAt: now, ...entity }))];
    const saved = await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, entities, relations: snapshot.relations, deletedIds: removed, revivedIds: [] }) });
    return saved.status;
  }, [add, removeIds, replace] as const);
  expect(status).toBe(200);
}
const task = (id: string, title: string) => ({ id, type: "task", title, status: "open", workspaceId: "personal", properties: { inbox: true } });
const note = (id: string, title: string, content: string) => ({ id, type: "note", title, content, status: "active", workspaceId: "personal", properties: {} });

function post(page: Page, url: string, body: Record<string, unknown>) {
  return page.evaluate(async ([target, payload]) => {
    const response = await fetch(target as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), workspaceId: "personal", ...(payload as object) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, [url, body] as const);
}
async function createClaim(page: Page, predicate: string, value: string) {
  const result = await post(page, "/api/context/claims", { action: "create", id: crypto.randomUUID(), expectedRevision: 0, subject: { entityId: "workspace:personal" },
    predicate, literal: { type: "string", value }, freshness: "current", sensitivity: "normal" });
  expect([200, 201]).toContain(result.status);
  return result.body.claim as Claim;
}
async function createSource(page: Page) {
  const result = await post(page, "/api/context/sources", { action: "create", id: crypto.randomUUID(), expectedRevision: 0, provider: "email", coverage: "metadata", sensitivity: "normal" });
  expect([200, 201]).toContain(result.status);
  return result.body.source as { id: string; revision: number };
}
const claims = (page: Page) => page.evaluate(async () => ((await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" }).then((response) => response.json())).claims || []) as Claim[]);
const sources = (page: Page) => page.evaluate(async () => ((await fetch("/api/context/sources?workspaceId=personal", { cache: "no-store" }).then((response) => response.json())).sources || []) as Array<{ id: string; revision: number }>);

async function cleanUp(page: Page) {
  if (!page.url().startsWith("http")) await page.goto("/");
  await page.evaluate(async (prefix) => {
    const list = ((await fetch("/api/context/claims?workspaceId=personal", { cache: "no-store" }).then((response) => response.json())).claims || []) as Claim[];
    for (const claim of list.filter((item) => item.predicate.startsWith(prefix))) {
      await fetch("/api/context/claims", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "archive", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: claim.id, expectedRevision: claim.revision }) });
    }
    const found = ((await fetch("/api/context/sources?workspaceId=personal", { cache: "no-store" }).then((response) => response.json())).sources || []) as Array<{ id: string; revision: number; provider?: string }>;
    for (const source of found) {
      await fetch("/api/context/sources", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "archive", idempotencyKey: crypto.randomUUID(), workspaceId: "personal", id: source.id, expectedRevision: source.revision }) });
    }
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const mine = snapshot.entities.filter((entity: { id: string }) => entity.id.startsWith("e2e-backup-"));
    if (mine.length) {
      await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
        entities: snapshot.entities.filter((entity: { id: string }) => !entity.id.startsWith("e2e-backup-")), relations: snapshot.relations,
        deletedIds: mine.map((entity: { id: string }) => entity.id), revivedIds: [] }) });
    }
  }, marker);
}
test.afterEach(async ({ page }) => { await cleanUp(page).catch(() => undefined); });

async function openBackups(page: Page) {
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await page.locator(".settingsTabs button", { hasText: "Data a zálohy" }).click();
  await expect(page.getByRole("button", { name: "Vytvořit zálohu" })).toBeVisible();
}
const rows = (page: Page) => page.locator(".backupList > div");
const manualRow = (page: Page) => rows(page).filter({ hasText: "ruční" }).first();
const status = (page: Page) => page.locator(".settingsPanel").getByRole("status").or(page.locator(".settingsPanel").getByRole("alert")).first();
async function confirmRestore(page: Page) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Obnovit", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
const undoLabel = async (page: Page) => (await page.locator(".contextHistoryBar").getByRole("button", { name: /^Zpět/ }).innerText()).trim();
async function openContext(page: Page) {
  await page.goto("/?view=Context");
  await expect(page.locator("#context-claim-editor")).toBeVisible();
  await waitUntilSynced(page);
}
const versionCount = async (page: Page, id: string) => {
  await page.goto(`/?task=${id}`);
  await expect(page.getByLabel("Text poznámky").first()).toBeVisible();
  await waitUntilSynced(page);
  return page.locator(".revisionList li").count();
};

test("restoring a full backup returns records, Context with its Undo step, sources and note versions", async ({ page }) => {
  const kept = `e2e-backup-kept-${stamp}`, removed = `e2e-backup-removed-${stamp}`, added = `e2e-backup-added-${stamp}`, noteId = `e2e-backup-note-${stamp}`;
  await page.goto("/");
  await waitUntilSynced(page);
  // The state to be backed up: two tasks, a note with two versions, a claim and a source.
  await setStore(page, [task(kept, "Záloha: zachovaný úkol"), task(removed, "Záloha: úkol smazaný později"), note(noteId, "Záloha: poznámka", "text ve záloze")]);
  await setStore(page, [], [], { [noteId]: { ...note(noteId, "Záloha: poznámka", "text ve záloze, druhá verze"), createdAt: 1, updatedAt: Date.now() } });
  const claimA = await createClaim(page, `${marker}.a`, "hodnota ve záloze");
  await createSource(page);
  const sourceCountAtBackup = (await sources(page)).length;

  await openContext(page);
  await expect(page.locator(".contextClaimCard", { hasText: `${marker}.a` })).toBeVisible();
  const undoAtBackup = await undoLabel(page);
  const versionsAtBackup = await versionCount(page, noteId);
  expect(versionsAtBackup).toBe(2);

  await openBackups(page);
  const before = await rows(page).count();
  await page.getByRole("button", { name: "Vytvořit zálohu" }).click();
  await expect(status(page)).toHaveText("Záloha vytvořena.");
  await expect(rows(page).first()).toContainText("Úplná");
  await expect(rows(page).first()).toContainText("ruční");
  await expect(rows(page).first()).toContainText(/\d+ (záznam|záznamy|záznamů) · \d+ tvrzení · \d+ (zdroj|zdroje|zdrojů) · \d+ (verze poznámky|verze poznámek|verzí poznámek) · \d+ (pracovní blok|pracovní bloky|pracovních bloků)/);
  expect(await rows(page).count()).toBeGreaterThanOrEqual(Math.min(before + 1, 8));

  // After the backup: a task is deleted and another added, the note changes, a claim and a source are added, the claim is edited.
  await page.goto("/");
  await waitUntilSynced(page);
  await setStore(page, [task(added, "Záloha: úkol přidaný po záloze")], [removed], { [noteId]: { ...note(noteId, "Záloha: poznámka", "text po záloze"), createdAt: 1, updatedAt: Date.now() } });
  await createClaim(page, `${marker}.b`, "hodnota po záloze");
  await createSource(page);
  const edited = await post(page, "/api/context/claims", { action: "update", id: claimA.id, expectedRevision: claimA.revision, predicate: claimA.predicate,
    literal: { type: "string", value: "hodnota změněná po záloze" }, freshness: "current", sensitivity: "normal" });
  expect([200, 201]).toContain(edited.status);
  await openContext(page);
  await expect(page.locator(".contextClaimCard", { hasText: `${marker}.b` })).toBeVisible();
  const undoAfter = await undoLabel(page);
  expect(undoAfter).not.toBe("");
  expect(await versionCount(page, noteId)).toBe(3);

  await openBackups(page);
  await manualRow(page).getByRole("button", { name: "Obnovit" }).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("Kontext včetně historie Zpět a Znovu");
  await expect(dialog).toContainText("Nejdřív se vytvoří bezpečnostní záloha");
  await expect(dialog).toContainText("zůstane jen v ní");
  await confirmRestore(page);
  await expect(status(page)).toHaveText("Záloha obnovena.");
  await expect(rows(page).filter({ hasText: "před obnovením" }).first()).toBeVisible();

  // Everything is as at backup time, in the interface and on the server.
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.id.startsWith("e2e-backup-")).map((entity) => entity.id).sort(), { timeout: 20_000 })
    .toEqual([kept, removed, noteId].sort());
  const current = await claims(page);
  expect(current.find((claim) => claim.predicate === `${marker}.a`)?.literal?.value).toBe("hodnota ve záloze");
  expect(current.some((claim) => claim.predicate === `${marker}.b`)).toBe(false);
  expect(await sources(page)).toHaveLength(sourceCountAtBackup);
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await expect(page.getByText("Záloha: úkol smazaný později")).toBeVisible();
  await expect(page.getByText("Záloha: úkol přidaný po záloze")).toHaveCount(0);
  await openContext(page);
  await expect(page.locator(".contextClaimCard", { hasText: `${marker}.a` })).toContainText("hodnota ve záloze");
  await expect(page.locator(".contextClaimCard", { hasText: `${marker}.b` })).toHaveCount(0);
  expect(await undoLabel(page)).toBe(undoAtBackup);
  expect(await versionCount(page, noteId)).toBe(versionsAtBackup);
  await expect(page.getByLabel("Text poznámky").first()).toHaveValue("text ve záloze, druhá verze");
});

test("an export is downloaded and importing it returns the state of the export", async ({ page }, testInfo) => {
  const kept = `e2e-backup-exported-${stamp}`, added = `e2e-backup-later-${stamp}`, noteId = `e2e-backup-exnote-${stamp}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await setStore(page, [task(kept, "Export: úkol v exportu"), note(noteId, "Export: poznámka", "řádek 1\n\n- bod")]);
  const claim = await createClaim(page, `${marker}.export`, "hodnota v exportu");
  await openBackups(page);

  // A keyboard user reaches the download button and starts it with Enter.
  await page.getByRole("button", { name: "Stáhnout export" }).focus();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(download.suggestedFilename()).toMatch(/^lumi-export-.*\.zip$/);
  const file = testInfo.outputPath("export.zip");
  await download.saveAs(file);
  await expect(status(page)).toHaveText("Export stažen.");
  const entries = unzipSync(new Uint8Array(readFileSync(file)));
  expect(Object.keys(entries)).toEqual(expect.arrayContaining(["manifest.json", "database.sqlite", "history/context-changes.jsonl", "history/note-revisions.jsonl", "data/context_claims.json"]));
  const markdown = Object.entries(entries).find(([name]) => name.startsWith("notes/") && Buffer.from(entries[name]).toString("utf8").includes(noteId));
  expect(markdown).toBeTruthy();
  expect(Buffer.from(markdown![1]).toString("utf8")).toContain("řádek 1");
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  expect(manifest.format).toBe("lumi-export");
  expect(Object.keys(manifest.files)).toContain("database.sqlite");

  // The state changes, then the export is imported.
  await page.goto("/");
  await waitUntilSynced(page);
  await setStore(page, [task(added, "Export: úkol po exportu")], [kept]);
  await createClaim(page, `${marker}.export-later`, "hodnota po exportu");
  await openBackups(page);

  // A package that was changed after it was made is refused and nothing changes.
  const tampered = { ...entries, [markdown![0]]: new TextEncoder().encode("změněno") };
  await page.locator("#backupImportInput").setInputFiles({ name: "zmeneny-export.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(tampered)) });
  await confirmRestore(page);
  await expect(status(page)).toContainText("Import se nepodařil. Současná data zůstala beze změny.");
  await expect(status(page)).toContainText("neodpovídá kontrolním součtům");
  expect((await serverEntities(page)).some((entity) => entity.id === added)).toBe(true);

  await page.locator("#backupImportInput").setInputFiles(file);
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("export.zip");
  await expect(dialog).toContainText("s původními ID");
  await confirmRestore(page);
  await expect(status(page)).toHaveText("Export naimportován.");
  await expect.poll(async () => (await serverEntities(page)).filter((entity) => entity.id.startsWith("e2e-backup-")).map((entity) => entity.id).sort(), { timeout: 20_000 })
    .toEqual([kept, noteId].sort());
  const current = await claims(page);
  expect(current.map((item) => item.predicate)).toContain(`${marker}.export`);
  expect(current.map((item) => item.predicate)).not.toContain(`${marker}.export-later`);
  expect(current.find((item) => item.id === claim.id)?.literal?.value).toBe("hodnota v exportu");
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await expect(page.getByText("Export: úkol v exportu")).toBeVisible();
  await expect(page.getByText("Export: úkol po exportu")).toHaveCount(0);
});

test("a restore replaces the local copy: held-back records and pending changes of the replaced data are gone and never sent", async ({ page }) => {
  const kept = `e2e-backup-replace-${stamp}`, held = `e2e-backup-held-${stamp}`, localOnly = `e2e-backup-localonly-${stamp}`;
  await page.goto("/");
  await waitUntilSynced(page);
  await setStore(page, [task(kept, "Záloha: úkol, který přežije")]);
  // A second tab of the same browser, open while the first restores.
  const other = await page.context().newPage();
  await other.goto("/?view=Inbox");
  await waitUntilSynced(other);
  await openBackups(page);
  await page.getByRole("button", { name: "Vytvořit zálohu" }).click();
  await expect(status(page)).toHaveText("Záloha vytvořena.");
  await manualRow(page).getByRole("button", { name: "Obnovit" }).click();
  await expect(confirmDialog(page)).toBeVisible();
  // State that exists only in this browser: a record the server would refuse (no title), a valid record not sent yet, a
  // deletion of the kept task not sent yet, and the flag that something waits to be sent.
  await page.evaluate(async ([heldId, localId, keptId]) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ai-executive"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const now = Date.now() + 60_000;
    const record = (id: string, title: string) => ({ id, type: "task", title, status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: now, updatedAt: now });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("entities", "readwrite");
      transaction.objectStore("entities").put(record(heldId, ""));
      transaction.objectStore("entities").put(record(localId, "Jen v tomto prohlížeči"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    localStorage.setItem("ai-executive-pending-deletions:0000000000000-e2e-000001", keptId);
    localStorage.setItem("ai-executive-pending-sync", "1");
  }, [held, localOnly, kept]);
  await confirmRestore(page);
  await expect(status(page)).toHaveText("Záloha obnovena.");
  const local = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ai-executive"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const ids = await new Promise<string[]>((resolve, reject) => { const request = database.transaction("entities").objectStore("entities").getAllKeys(); request.onsuccess = () => resolve(request.result as string[]); request.onerror = () => reject(request.error); });
    database.close();
    return { ids, pending: localStorage.getItem("ai-executive-pending-sync"), markers: Object.keys(localStorage).filter((key) => key.startsWith("ai-executive-pending-deletions") || key.startsWith("ai-executive-pending-revivals")) };
  });
  expect(local.ids).toContain(kept);
  expect(local.ids).not.toContain(held);
  expect(local.ids).not.toContain(localOnly);
  expect(local.pending).toBeNull();
  expect(local.markers).toEqual([]);
  // Nothing of it comes back: after later saves and a reload the server and the browser still hold only the restored data.
  await setStore(page, [task(`e2e-backup-after-${stamp}`, "Záloha: po obnovení")]);
  await page.reload();
  await waitUntilSynced(page);
  const server = (await serverEntities(page)).map((entity) => entity.id);
  expect(server).toContain(kept);
  expect(server).not.toContain(held);
  expect(server).not.toContain(localOnly);
  await page.goto("/?view=Inbox");
  await expect(page.getByText("Záloha: úkol, který přežije")).toBeVisible();
  await expect(page.getByText("Jen v tomto prohlížeči")).toHaveCount(0);
  // The other tab shows the same restored copy.
  await expect(other.getByText("Záloha: úkol, který přežije")).toBeVisible();
  await expect(other.getByText("Jen v tomto prohlížeči")).toHaveCount(0);
  await other.close();
});

test("a backup older than the current format is marked and its restore says that Context is not changed", async ({ page }) => {
  await openBackups(page);
  // The instance has no JSON backups; the list only marks them, so one is supplied through the list response.
  await page.route("**/api/backups", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.backups = [{ name: "2026-01-02T03-04-05-678Z-manual.json", format: "legacy", label: "manual", createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), entityCount: 7, relationCount: 2,
      claimCount: 0, sourceCount: 0, noteRevisionCount: 0, workSessionCount: 0 }, ...data.backups];
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await waitUntilSynced(page);
  await page.locator(".settingsTabs button", { hasText: "Data a zálohy" }).click();
  const legacy = rows(page).filter({ hasText: "Starší záloha — jen úkoly, projekty a poznámky" }).first();
  await expect(legacy).toContainText("7 položek");
  await legacy.getByRole("button", { name: "Obnovit" }).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("Kontext, jeho historie a verze poznámek se nemění");
  await dialog.getByRole("button", { name: "Zrušit" }).click();
  await expect(dialog).not.toBeVisible();
});

test("the backup section fits a 390 px screen and its controls are 44 px high", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBackups(page);
  await expect(rows(page).first()).toBeVisible();
  const layout = await page.evaluate(() => {
    const section = document.querySelector(".backupList")!.closest("section")!;
    const controls = [...section.querySelectorAll<HTMLElement>("button")].filter((button) => button.offsetParent !== null);
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      small: controls.filter((button) => button.getBoundingClientRect().height < 43.5).map((button) => button.textContent),
      outside: controls.filter((button) => button.getBoundingClientRect().right > window.innerWidth + 0.5).map((button) => button.textContent),
      count: controls.length,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.small).toEqual([]);
  expect(layout.outside).toEqual([]);
  expect(layout.count).toBeGreaterThanOrEqual(4);
  // Scrolled to the end, the last row's button is not under the bottom bar or its add button.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const covered = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLElement>(".backupList button")];
    const last = buttons[buttons.length - 1];
    const box = last.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { covered: !(top === last || last.contains(top)), bottom: box.bottom, height: window.innerHeight };
  });
  expect(covered.covered).toBe(false);
});
