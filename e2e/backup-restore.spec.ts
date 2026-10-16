import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { confirmDialog, serverEntities, waitUntilSynced } from "./helpers";
import { sessionFile } from "../playwright.config";

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
      body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration, entities, relations: snapshot.relations, deletedIds: removed, revivedIds: [] }) });
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
      await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
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

test("a device with an unsent change from before a restore on another device discards it and shows the restored data", async ({ browser }) => {
  const kept = `e2e-backup-device-${stamp}`;
  const open = async () => {
    const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
    return { context, page: await context.newPage() };
  };
  const first = await open(), second = await open();
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    await setStore(first.page, [task(kept, "Zařízení: úkol v záloze")]);
    await second.page.goto("/?view=Inbox");
    await waitUntilSynced(second.page);
    await expect(second.page.getByText("Zařízení: úkol v záloze")).toBeVisible({ timeout: 20_000 });
    // The first device backs up, then the second goes offline and records a task.
    const name = await first.page.evaluate(async () => {
      await fetch("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create" }) });
      const list = (await fetch("/api/backups", { cache: "no-store" }).then((response) => response.json())).backups as Array<{ name: string; label: string }>;
      return list.find((backup) => backup.label === "manual")!.name;
    });
    await second.context.setOffline(true);
    const field = second.page.locator(".capture input");
    await field.fill("Zařízení: změna před obnovením");
    await field.press("Enter");
    await expect(second.page.getByText("Zařízení: změna před obnovením")).toBeVisible();
    // The first device restores; the second comes back online with its unsent change.
    const restored = await first.page.evaluate(async (backup) => (await fetch("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "restore", name: backup }) })).status, name);
    expect(restored).toBe(200);
    await second.context.setOffline(false);
    const notice = second.page.locator(".restoredNotice");
    await expect(notice).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await expect(notice).toContainText("neodeslané se zahodily");
    await expect(second.page.getByText("Zařízení: změna před obnovením")).toHaveCount(0);
    await expect(second.page.getByText("Zařízení: úkol v záloze")).toBeVisible();
    await waitUntilSynced(second.page);
    expect((await serverEntities(first.page)).map((entity) => entity.title)).not.toContain("Zařízení: změna před obnovením");
    // It stays discarded after a reload, and the device saves normally again.
    await second.page.reload();
    await waitUntilSynced(second.page);
    await expect(second.page.getByText("Zařízení: změna před obnovením")).toHaveCount(0);
    await second.page.locator(".capture input").fill("Zařízení: změna po obnovení");
    await second.page.locator(".capture input").press("Enter");
    await expect.poll(async () => (await serverEntities(first.page)).map((entity) => entity.title), { timeout: 20_000 }).toContain("Zařízení: změna po obnovení");
    await expect(second.page.locator(".restoredNotice")).toHaveCount(0);
  } finally {
    await first.page.evaluate(async () => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const mine = snapshot.entities.filter((entity: { title: string }) => entity.title.startsWith("Zařízení:")).map((entity: { id: string }) => entity.id);
      if (mine.length) await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision, restoreGeneration: snapshot.restoreGeneration,
        entities: snapshot.entities.filter((entity: { id: string }) => !mine.includes(entity.id)), relations: snapshot.relations, deletedIds: mine, revivedIds: [] }) });
    }).catch(() => undefined);
    await first.context.close();
    await second.context.close();
  }
});

async function twoDevices(browser: import("@playwright/test").Browser) {
  const open = async () => {
    const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
    return { context, page: await context.newPage() };
  };
  return { first: await open(), second: await open() };
}
const createManualBackup = (page: Page) => page.evaluate(async () => {
  await fetch("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create" }) });
  const list = (await fetch("/api/backups", { cache: "no-store" }).then((response) => response.json())).backups as Array<{ name: string; label: string }>;
  return list.find((backup) => backup.label === "manual")!.name;
});
const restoreByApi = (page: Page, name: string) => page.evaluate(async (backup) =>
  (await fetch("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "restore", name: backup }) })).status, name);
const remoteWakeUp = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });

test("a restore between the start-up read and the start-up save of another device does not bring its old changes back", async ({ browser }) => {
  const kept = `e2e-backup-startup-${stamp}`, local = `e2e-backup-startup-local-${stamp}`;
  const { first, second } = await twoDevices(browser);
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    await setStore(first.page, [task(kept, "Start: úkol v záloze")]);
    await second.page.goto("/?view=Inbox");
    await waitUntilSynced(second.page);
    const name = await createManualBackup(first.page);
    // The second device holds a change that was never sent (made before the restore).
    await second.page.evaluate(async (id) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ai-executive"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const now = Date.now() + 60_000;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("entities", "readwrite");
        transaction.objectStore("entities").put({ id, type: "task", title: "Start: změna před obnovením", status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: now, updatedAt: now });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      localStorage.setItem("ai-executive-pending-sync", "1");
    }, local);
    // Its start-up save is held until the other device has restored.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sawSave: () => void = () => {};
    const saveSeen = new Promise<void>((resolve) => { sawSave = resolve; });
    await second.page.route("**/api/store", async (route) => {
      if (route.request().method() === "PUT") { sawSave(); await gate; }
      await route.continue();
    });
    void second.page.reload({ waitUntil: "commit" }).catch(() => undefined);
    await saveSeen;
    expect(await restoreByApi(first.page, name)).toBe(200);
    release();
    await expect(second.page.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await waitUntilSynced(second.page);
    expect((await serverEntities(first.page)).map((entity) => entity.id)).not.toContain(local);
    expect((await serverEntities(first.page)).map((entity) => entity.id)).toContain(kept);
    await expect(second.page.getByText("Start: změna před obnovením")).toHaveCount(0);
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("Context, open on another device, shows the restored state without navigating", async ({ browser }) => {
  const { first, second } = await twoDevices(browser);
  const predicate = `${marker}.remote`;
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    const name = await createManualBackup(first.page);
    await createClaim(first.page, predicate, "vznikne po záloze");
    await openContext(second.page);
    await expect(second.page.locator(".contextClaimCard", { hasText: predicate })).toBeVisible();
    expect(await restoreByApi(first.page, name)).toBe(200);
    await remoteWakeUp(second.page);
    // The page reloads and says why.
    await expect(second.page.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await expect(second.page.locator(".contextClaimCard", { hasText: predicate })).toHaveCount(0, { timeout: 30_000 });
    expect((await claims(second.page)).some((claim) => claim.predicate === predicate)).toBe(false);
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("a task-notes draft typed before a restore elsewhere is dropped and cannot overwrite the restored record", async ({ browser }) => {
  const id = `e2e-backup-draft-${stamp}`;
  const entity = (notes: string) => ({ id, type: "task", title: "Koncept: úkol", status: "open", workspaceId: "personal", properties: { inbox: true, notes }, createdAt: 1, updatedAt: Date.now() });
  const { first, second } = await twoDevices(browser);
  const serverNotes = async () => ((await serverEntities(first.page)).find((item) => item.id === id)?.properties as { notes?: string } | undefined)?.notes;
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    await setStore(first.page, [entity("původní poznámky")]);
    const name = await createManualBackup(first.page);
    await setStore(first.page, [], [], { [id]: entity("změněno po záloze") });
    await second.page.goto(`/?task=${id}`);
    await waitUntilSynced(second.page);
    const field = second.page.getByLabel("Poznámky k úkolu");
    await expect(field).toHaveValue("změněno po záloze");
    await field.fill("koncept před obnovením");
    expect(await restoreByApi(first.page, name)).toBe(200);
    await remoteWakeUp(second.page);
    // The page reloaded (the open task is not kept in the address): opened again it shows the restored notes.
    await expect(second.page.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await second.page.goto(`/?task=${id}`);
    await waitUntilSynced(second.page);
    await expect(second.page.getByLabel("Poznámky k úkolu")).toHaveValue("původní poznámky", { timeout: 30_000 });
    // Leaving the field, the page being hidden or closed: nothing of the draft is saved over the restored record.
    await second.page.locator("input.titleEdit").focus();
    await second.page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); document.dispatchEvent(new Event("visibilitychange")); });
    await second.page.waitForTimeout(3000);
    await waitUntilSynced(second.page);
    expect(await serverNotes()).toBe("původní poznámky");
    await second.page.reload();
    await waitUntilSynced(second.page);
    expect(await serverNotes()).toBe("původní poznámky");
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("a title being edited on another device when a restore happens is not written back, and the page shows the restored title", async ({ browser }) => {
  const id = `e2e-backup-title-${stamp}`;
  const entity = (title: string) => ({ id, type: "task", title, status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: 1, updatedAt: Date.now() });
  const { first, second } = await twoDevices(browser);
  const serverTitle = async () => (await serverEntities(first.page)).find((item) => item.id === id)?.title;
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    await setStore(first.page, [entity("Titulek: původní")]);
    const name = await createManualBackup(first.page);
    await setStore(first.page, [], [], { [id]: entity("Titulek: změněný po záloze") });
    await second.page.goto(`/?task=${id}`);
    await waitUntilSynced(second.page);
    const field = second.page.locator("input.titleEdit");
    await expect(field).toHaveValue("Titulek: změněný po záloze");
    await field.fill("Titulek: rozepsaný před obnovením");
    expect(await restoreByApi(first.page, name)).toBe(200);
    await remoteWakeUp(second.page);
    // Leaving the field right away, while the page adopts the restored data, writes nothing.
    await field.blur().catch(() => undefined);
    await second.page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); document.dispatchEvent(new Event("visibilitychange")); }).catch(() => undefined);
    await expect(second.page.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await second.page.goto(`/?task=${id}`);
    await waitUntilSynced(second.page);
    await expect(second.page.locator("input.titleEdit")).toHaveValue("Titulek: původní", { timeout: 30_000 });
    await second.page.waitForTimeout(3000);
    await waitUntilSynced(second.page);
    expect(await serverTitle()).toBe("Titulek: původní");
    await second.page.locator("input.titleEdit").focus();
    await second.page.getByLabel("Poznámky k úkolu").focus();
    await second.page.waitForTimeout(1500);
    expect(await serverTitle()).toBe("Titulek: původní");
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("a restore found by one tab reloads its sibling tab too: restored Context, no stale draft, no pre-restore edit", async ({ browser }) => {
  const predicate = `${marker}.sibling`;
  const first = await (async () => { const context = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" }); return { context, page: await context.newPage() }; })();
  const deviceB = await browser.newContext({ storageState: sessionFile, locale: "cs-CZ" });
  const tab1 = await deviceB.newPage(), tab2 = await deviceB.newPage();
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    const name = await createManualBackup(first.page);
    await createClaim(first.page, predicate, "vznikne po záloze");
    await openContext(tab1);
    await openContext(tab2);
    await expect(tab2.locator(".contextClaimCard", { hasText: predicate })).toBeVisible();
    // The sibling holds a Context draft typed before the restore.
    await tab2.locator("#context-claim-editor").getByLabel("Vztah nebo vlastnost").fill("e2e.backup.stale-draft");
    await tab2.locator("#context-claim-editor").getByLabel("Hodnota", { exact: true }).fill("rozepsáno před obnovením");
    expect(await restoreByApi(first.page, name)).toBe(200);
    // Only the first tab is woken; the sibling has to follow it.
    await remoteWakeUp(tab1);
    await expect(tab1.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await expect(tab2.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await expect(tab2.locator(".contextClaimCard", { hasText: predicate })).toHaveCount(0);
    await expect(tab2.locator("#context-claim-editor").getByLabel("Vztah nebo vlastnost")).not.toHaveValue("e2e.backup.stale-draft");
    await expect(tab2.locator("#context-claim-editor").getByLabel("Hodnota", { exact: true })).toHaveValue("");
    expect((await claims(first.page)).some((claim) => claim.predicate === predicate || claim.predicate === "e2e.backup.stale-draft")).toBe(false);
  } finally {
    await first.context.close();
    await deviceB.close();
  }
});

test("a Context claim created on a device that has not learned of a restore is refused and the device adopts the restored data", async ({ browser }) => {
  const predicate = `${marker}.fenced`;
  const { first, second } = await twoDevices(browser);
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    const name = await createManualBackup(first.page);
    await openContext(second.page);
    expect(await restoreByApi(first.page, name)).toBe(200);
    // The second device is not woken: it still holds the data that was replaced and tries to write on top of it.
    const editor = second.page.locator("#context-claim-editor");
    await editor.getByLabel("O kom / čem").selectOption("workspace:personal");
    await editor.getByLabel("Vztah nebo vlastnost").fill(predicate);
    await editor.getByLabel("Hodnota", { exact: true }).fill("napsáno nad obnovená data");
    await editor.getByRole("button", { name: "Uložit", exact: true }).click();
    await expect(second.page.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    expect((await claims(first.page)).some((claim) => claim.predicate === predicate)).toBe(false);
    await expect(second.page.locator(".contextClaimCard", { hasText: predicate })).toHaveCount(0);
    // After the reload the device writes normally.
    await second.page.locator("#context-claim-editor").getByLabel("O kom / čem").selectOption("workspace:personal");
    await second.page.locator("#context-claim-editor").getByLabel("Vztah nebo vlastnost").fill(`${predicate}.again`);
    await second.page.locator("#context-claim-editor").getByLabel("Hodnota", { exact: true }).fill("po obnovení");
    await second.page.locator("#context-claim-editor").getByRole("button", { name: "Uložit", exact: true }).click();
    await expect.poll(async () => (await claims(first.page)).some((claim) => claim.predicate === `${predicate}.again`), { timeout: 20_000 }).toBe(true);
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("when the local copy cannot be replaced during adoption the page still reloads, emptied, and shows the restored data", async ({ browser }) => {
  const kept = `e2e-backup-quota-${stamp}`, local = `e2e-backup-quota-local-${stamp}`;
  const { first, second } = await twoDevices(browser);
  try {
    await first.page.goto("/");
    await waitUntilSynced(first.page);
    await setStore(first.page, [task(kept, "Kvóta: úkol v záloze")]);
    await second.page.goto("/?view=Inbox");
    await waitUntilSynced(second.page);
    const name = await createManualBackup(first.page);
    expect(await restoreByApi(first.page, name)).toBe(200);
    // The second device holds a record that exists only here, and its storage refuses every write (quota) from now on.
    await second.page.evaluate(async (id) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ai-executive"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const now = Date.now() + 60_000;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("entities", "readwrite");
        transaction.objectStore("entities").put({ id, type: "task", title: "Kvóta: jen v tomto prohlížeči", status: "open", workspaceId: "personal", properties: { inbox: true }, createdAt: now, updatedAt: now });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      const refuse = () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
      const proto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
      for (const method of ["add", "put", "addAll", "putAll"]) if (typeof proto[method] === "function") proto[method] = refuse;
    }, local);
    await remoteWakeUp(second.page);
    await expect(second.page.locator(".restoredNotice")).toContainText("Data byla obnovena ze zálohy.", { timeout: 30_000 });
    await waitUntilSynced(second.page);
    await second.page.goto("/?view=Inbox");
    await expect(second.page.getByText("Kvóta: úkol v záloze")).toBeVisible({ timeout: 20_000 });
    await expect(second.page.getByText("Kvóta: jen v tomto prohlížeči")).toHaveCount(0);
    expect((await serverEntities(first.page)).map((entity) => entity.id)).not.toContain(local);
  } finally {
    await first.context.close();
    await second.context.close();
  }
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
