import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

/** Focused isolated Chromium tests for the cross-tab note metadata lease.
 * No application server, real login, UI, production cache or background timer. */
function compile(filename: string): string {
  const source = readFileSync(resolve(process.cwd(), "lib/target-sync", filename), "utf8");
  const js = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
    .replace(/^\s*import[\s\S]*?from ["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+\{\s*\};?/g, "")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:class|const|function)\b)/g, "");
  if (/^\s*(?:import|export)\s/m.test(js)) throw new Error("Unexpected syntax in " + filename);
  return js;
}
const shared = ["storage.ts", "indexeddb.ts", "note-pages.ts", "note-http.ts", "note-persistent.ts"]
  .map(compile).join("\n");
const script = "(function(){\n" + shared +
  "\n const IndexedDbNoteMetadataLease = (function(){\n" +
  compile("note-lease.ts") + "\n return IndexedDbNoteMetadataLease;\n })();\n" +
  "globalThis.__noteLease = { IndexedDbNoteMetadataLease, IndexedDbTargetSyncStorage, noteMetadataNamespace };\n})();";

async function harness(page: Page) {
  const url = "http://localhost:3101/note-lease-browser";
  await page.route(url, route => route.fulfill({ status: 200, contentType: "text/html",
    body: "<!doctype html><title>Lumi note lease isolated</title>" }));
  await page.goto(url);
  await page.addScriptTag({ content: script });
}

test("two tabs cannot simultaneously own a note database; stale owner cannot publish checkpoint", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([harness(page), harness(second)]);
  const dbName = "lumi-note-lease-" + randomUUID();
  const first = await page.evaluate(async name => {
    const { IndexedDbNoteMetadataLease: Lease, IndexedDbTargetSyncStorage: Storage,
      noteMetadataNamespace } = (globalThis as any).__noteLease;
    const scope = { userId: "alice", areaId: "personal",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const namespace = noteMetadataNamespace(scope);
    const storage = new Storage(name);
    const handle = await storage.openNamespace(namespace);
    const lease = new Lease(name);
    const claim = await lease.claim();
    if (claim.kind !== "acquired") throw new Error("lease expected");
    const marker = await lease.marker(namespace);
    const checkpoint = (revision: number) => ({ version: 1, scope, state: {
      phase: "changes", cursor: "A".repeat(4135), pending: [],
      visible: [{ id: "one", revision, projectId: null, parentRevision: null }],
    } });
    await lease.checkpoint(claim.lease, namespace, marker, checkpoint(1));
    (globalThis as any).__old = { lease, ticket: claim.lease, namespace, marker, checkpoint };
    return { kind: claim.kind, revision: (await handle.get("checkpoint")).state.visible[0].revision };
  }, dbName);
  expect(first).toEqual({ kind: "acquired", revision: 1 });

  const busy = await second.evaluate(async name => {
    const { IndexedDbNoteMetadataLease: Lease } = (globalThis as any).__noteLease;
    (globalThis as any).__new = new Lease(name);
    return (await (globalThis as any).__new.claim()).kind;
  }, dbName);
  expect(busy).toBe("busy");

  expect(await page.evaluate(async () => {
    const v = (globalThis as any).__old;
    return v.lease.release(v.ticket);
  })).toBe(true);
  const acquired = await second.evaluate(async () => {
    const lease = (globalThis as any).__new;
    const claim = await lease.claim();
    if (claim.kind !== "acquired") throw Error("new lease expected");
    (globalThis as any).__newTicket = claim.lease;
    return claim.kind;
  });
  expect(acquired).toBe("acquired");

  const stale = await page.evaluate(async () => {
    const v = (globalThis as any).__old;
    let rejected = false;
    try { await v.lease.checkpoint(v.ticket, v.namespace, v.marker, v.checkpoint(999)); }
    catch (error) { rejected = String(error).includes("note_lease_lost"); }
    return { rejected, staleRenew: await v.lease.renew(v.ticket),
      staleRelease: await v.lease.release(v.ticket) };
  });
  expect(stale).toEqual({ rejected: true, staleRenew: false, staleRelease: false });

  const committed = await second.evaluate(async name => {
    const { IndexedDbTargetSyncStorage: Storage, noteMetadataNamespace } =
      (globalThis as any).__noteLease;
    const lease = (globalThis as any).__new, ticket = (globalThis as any).__newTicket;
    const scope = { userId: "alice", areaId: "personal",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const namespace = noteMetadataNamespace(scope);
    const marker = await lease.marker(namespace);
    const checkpoint = { version: 1, scope, state: {
      phase: "changes", cursor: "B".repeat(4135), pending: [],
      visible: [{ id: "one", revision: 2, projectId: null, parentRevision: null }],
    } };
    await lease.checkpoint(ticket, namespace, marker, checkpoint);
    const handle = await new Storage(name).openNamespace(namespace);
    const saved = await handle.get("checkpoint");
    return { version: saved.version, revision: saved.state.visible[0].revision,
      cursor: saved.state.cursor[0], released: await lease.release(ticket) };
  }, dbName);
  expect(committed).toEqual({ version: 1, revision: 2, cursor: "B", released: true });
  await second.close();
});

test("expired owner loses write fence even without another claimant; successor advances durable epoch", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbNoteMetadataLease: Lease, IndexedDbTargetSyncStorage: Storage,
      noteMetadataNamespace } = (globalThis as any).__noteLease;
    let now = 1000;
    const db = "lumi-note-lease-" + crypto.randomUUID();
    const first = new Lease(db, () => now), second = new Lease(db, () => now);
    const scope = { userId: "alice", areaId: "A",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const namespace = noteMetadataNamespace(scope);
    const handle = await new Storage(db).openNamespace(namespace);
    const marker = await first.marker(namespace);
    const initial = await first.claim();
    if (initial.kind !== "acquired") throw Error("missing initial lease");
    now = 30_999;
    const renewed = await first.renew(initial.lease);
    now = 61_000;
    const expiredRenew = await first.renew(initial.lease);
    let expiredWrite = "";
    try { await first.checkpoint(initial.lease, namespace, marker, null); }
    catch (e) { expiredWrite = String(e); }
    const newClaim = await second.claim();
    if (newClaim.kind !== "acquired") throw Error("missing successor");
    const staleRelease = await first.release(initial.lease);
    const checkpoint = { version: 1, scope, state: {
      phase: "changes", cursor: "A".repeat(4135), pending: [],
      visible: [{ id: "only", revision: 0, projectId: null, parentRevision: null }],
    } };
    await second.checkpoint(newClaim.lease, namespace, marker, checkpoint);
    const saved = await handle.get("checkpoint");
    return { renewed, expiredRenew, expiredWrite, staleRelease,
      epochs: [initial.lease.epoch, newClaim.lease.epoch],
      note: saved.state.visible[0].id };
  });
  expect(result.renewed).toBe(true);
  expect(result.expiredRenew).toBe(false);
  expect(result.expiredWrite).toContain("note_lease_lost");
  expect(result.staleRelease).toBe(false);
  expect(result.epochs).toEqual([1, 2]);
  expect(result.note).toBe("only");
});

test("deleted/recreated namespace and malformed/content-bearing checkpoints fail closed", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbNoteMetadataLease: Lease, IndexedDbTargetSyncStorage: Storage,
      noteMetadataNamespace } = (globalThis as any).__noteLease;
    const db = "lumi-note-lease-" + crypto.randomUUID();
    const scope = { userId: "alice", areaId: "private",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const name = noteMetadataNamespace(scope);
    const storage = new Storage(db);
    await storage.openNamespace(name);
    const lease = new Lease(db);
    const token = await lease.claim();
    if (token.kind !== "acquired") throw Error("claim");
    const oldMarker = await lease.marker(name);
    await storage.deleteNamespaces([name]);
    const replacement = await storage.openNamespace(name);
    const freshMarker = await lease.marker(name);
    let oldRejected = false;
    try { await lease.checkpoint(token.lease, name, oldMarker, null); }
    catch (e) { oldRejected = String(e).includes("note_lease_namespace_replaced"); }
    const checkpoint = { version: 1, scope, state: {
      phase: "changes", cursor: "A".repeat(4135), pending: [],
      visible: [{ id: "a", revision: 0, projectId: null, parentRevision: null }],
    } };
    let titleRejected = false, foreignRejected = false;
    try { await lease.checkpoint(token.lease, name, freshMarker,
      { ...checkpoint, state: { ...checkpoint.state,
        visible: [{ ...checkpoint.state.visible[0], title: "private text" }] } }); }
    catch (e) { titleRejected = String(e).includes("note_lease_invalid_checkpoint"); }
    try { await lease.checkpoint(token.lease, name, freshMarker,
      { ...checkpoint, scope: { ...scope, userId: "bob" } }); }
    catch (e) { foreignRejected = String(e).includes("note_lease_invalid_checkpoint"); }
    const before = await replacement.get("checkpoint");
    await lease.checkpoint(token.lease, name, freshMarker, checkpoint);
    const after = await replacement.get("checkpoint");
    return { markersChanged: oldMarker !== freshMarker, oldRejected, titleRejected,
      foreignRejected, before: before ?? null, note: after.state.visible[0].id,
      namespaces: await storage.listNamespaces() };
  });
  expect(result.markersChanged).toBe(true);
  expect(result.oldRejected).toBe(true);
  expect(result.titleRejected).toBe(true);
  expect(result.foreignRejected).toBe(true);
  expect(result.before).toBeNull();
  expect(result.note).toBe("a");
  expect(result.namespaces).toHaveLength(1);
});

test("checkpoint freezes metadata and lease token before the first async boundary", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbNoteMetadataLease: Lease, IndexedDbTargetSyncStorage: Storage,
      noteMetadataNamespace } = (globalThis as any).__noteLease;
    const db = "lumi-note-lease-" + crypto.randomUUID();
    const scope = { userId: "alice", areaId: "private",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const namespace = noteMetadataNamespace(scope);
    const handle = await new Storage(db).openNamespace(namespace);
    const lease = new Lease(db);
    const claim = await lease.claim();
    if (claim.kind !== "acquired") throw Error("claim");
    const marker = await lease.marker(namespace);
    const checkpoint = { version: 1, scope: { ...scope }, state: {
      phase: "changes", cursor: "A".repeat(4135), pending: [],
      visible: [{ id: "one", revision: 1, projectId: null, parentRevision: null }],
    } };
    const expected = structuredClone(checkpoint);
    const write = lease.checkpoint(claim.lease, namespace, marker, checkpoint);
    // Mutations happen immediately after dispatch but before its async DB work.
    // The live source object was valid at call time; only the snapshot may
    // be committed, with no later title/body or different actor scope.
    (checkpoint.state.visible[0] as any).title = "secret-note-title";
    (checkpoint.state as any).body = "secret-note-body";
    checkpoint.state.visible[0].revision = 100;
    checkpoint.scope.userId = "bob";
    await write;
    const saved = await handle.get("checkpoint");

    // A caller mutating the returned lease token must not change the
    // credentials already captured for a pending write.
    const second = structuredClone(expected);
    second.state.visible[0].revision = 2;
    const anotherWrite = lease.checkpoint(claim.lease, namespace, marker, second);
    claim.lease.epoch += 100;
    await anotherWrite;
    return { first: saved, expected, second: await handle.get("checkpoint"),
      expectedSecond: second };
  });
  expect(result.first).toEqual(result.expected);
  expect(result.second).toEqual(result.expectedSecond);
});

test("lease purge validates a fixed namespace set before asynchronous IndexedDB work", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbNoteMetadataLease: Lease, IndexedDbTargetSyncStorage: Storage,
      noteMetadataNamespace } = (globalThis as any).__noteLease;
    const db = "lumi-note-lease-" + crypto.randomUUID();
    const storage = new Storage(db);
    const base = { areaId: "private",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const alice = noteMetadataNamespace({ ...base, userId: "alice" });
    const bob = noteMetadataNamespace({ ...base, userId: "bob" });
    await storage.openNamespace(alice);
    await storage.openNamespace(bob);
    const lease = new Lease(db);
    const claim = await lease.claim();
    if (claim.kind !== "acquired") throw Error("claim");
    const targets = [alice];
    const pending = lease.deleteNamespaces(claim.lease, targets);
    targets[0] = bob;
    targets.push(bob);
    await pending;
    return storage.listNamespaces();
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toContain("bob");
  expect(result[0]).not.toContain("alice");
});
