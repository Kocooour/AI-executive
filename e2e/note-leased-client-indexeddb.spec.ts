import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

/** Real two-tab Chromium tests. All IndexedDB names are synthetic, unique per
 * test; no server, production credentials, task cache, UI or background poll. */
function compile(filename: string): string {
  const source = readFileSync(resolve(process.cwd(), "lib/target-sync", filename), "utf8");
  const js = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
    .replace(/^\s*import[\s\S]*?from ["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+\{\s*\};?/g, "")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:class|const|function)\b)/g, "");
  if (/^\s*(?:import|export)\s/m.test(js)) throw new Error("Unexpected module syntax in " + filename);
  return js;
}
const common = ["storage.ts", "indexeddb.ts", "note-pages.ts", "note-http.ts"]
  .map(compile).join("\n");
const script = "(function(){\n" + common +
  "\n const IndexedDbNoteMetadataLease = (function(){\n" + compile("note-lease.ts") +
  "\n return IndexedDbNoteMetadataLease;\n })();\n" +
  compile("note-leased.ts") + "\n" + compile("note-persistent.ts") +
  "\n globalThis.__leased = { createStagingNotePersistentClient, IndexedDbTargetSyncStorage }; \n})();";

async function harness(page: Page) {
  const url = "http://localhost:3101/note-leased-integration";
  await page.route(url, route => route.fulfill({ status: 200, contentType: "text/html",
    body: "<!doctype html><title>Lumi leased notes integration</title>" }));
  await page.goto(url);
  await page.addScriptTag({ content: script });
}

test("default note client has one cross-tab writer; denied tab signout revokes writer and purges actor", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([harness(page), harness(second)]);
  const db = "lumi-note-leased-" + randomUUID();
  const first = await page.evaluate(async name => {
    const create = (globalThis as any).__leased.createStagingNotePersistentClient;
    const scope = { userId: "alice", areaId: "private",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const client = create({ dbName: name, transport: async () => Response.json({
      phase: "bootstrap", cursor: "A".repeat(4135), more: false, changes: [],
      entries: [{ id: "alice-note", revision: 1, projectId: null, parentRevision: null }],
    }) });
    (globalThis as any).__first = client;
    return { activated: await client.activate(scope),
      pulled: (await client.pull()).kind, read: client.read() };
  }, db);
  expect(first).toEqual({ activated: "fresh", pulled: "applied",
    read: [{ id: "alice-note", revision: 1, projectId: null, parentRevision: null }] });

  const blocked = await second.evaluate(async name => {
    const create = (globalThis as any).__leased.createStagingNotePersistentClient;
    const scope = { userId: "bob", areaId: "private",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const client = create({ dbName: name, transport: async () => Response.json({
      phase: "bootstrap", cursor: "B".repeat(4135), more: false, changes: [],
      entries: [{ id: "bob-note", revision: 2, projectId: null, parentRevision: null }],
    }) });
    (globalThis as any).__second = client;
    (globalThis as any).__bobScope = scope;
    let error = "";
    try { await client.activate(scope); } catch (e) { error = String(e); }
    return { error, read: client.read(), scope: client.currentScope() };
  }, db);
  expect(blocked.error).toContain("note_cache_unavailable");
  expect(blocked.read).toEqual([]);
  expect(blocked.scope).toBeNull();

  // Signout from a tab that does not own the global writer still sends cache
  // revocation to the actual writer. It must NOT delete another live owner via
  // its own IndexedDB requests.
  await second.evaluate(async () => (globalThis as any).__second.clear());
  await expect.poll(() => page.evaluate(() => (globalThis as any).__first.read()),
    { timeout: 10000 }).toEqual([]);
  await expect.poll(async () => page.evaluate(async name => {
    const Storage = (globalThis as any).__leased.IndexedDbTargetSyncStorage;
    return (await new Storage(name).listNamespaces()).length;
  }, db), { timeout: 10000 }).toBe(0);
  const takeover = await second.evaluate(async name => {
    const client = (globalThis as any).__second;
    const scope = (globalThis as any).__bobScope;
    const activated = await client.activate(scope);
    const pulled = await client.pull();
    const Storage = (globalThis as any).__leased.IndexedDbTargetSyncStorage;
    const names = await new Storage(name).listNamespaces();
    return { activated, pulled: pulled.kind, read: client.read(), names };
  }, db);
  expect(takeover.activated).toBe("fresh");
  expect(takeover.pulled).toBe("applied");
  expect(takeover.read).toEqual([
    { id: "bob-note", revision: 2, projectId: null, parentRevision: null },
  ]);
  expect(takeover.names).toHaveLength(1);
  expect(takeover.names[0]).toContain("bob");
  expect(takeover.names[0]).not.toContain("alice");
  expect(await page.evaluate(() => (globalThis as any).__first.read())).toEqual([]);
  await second.evaluate(async () => (globalThis as any).__second.clear());
  await second.close();
});

test("cross-tab revocation fences a suspended HTTP result and cannot republish stale notes", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([harness(page), harness(second)]);
  const db = "lumi-note-leased-" + randomUUID();
  const before = await page.evaluate(async name => {
    const create = (globalThis as any).__leased.createStagingNotePersistentClient;
    const scope = { userId: "alice", areaId: "A",
      restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    (globalThis as any).__release = release;
    const client = create({ dbName: name, transport: async () => {
      calls++;
      if (calls > 1) await gate; // intentionally ignores AbortSignal
      return calls === 1 ? Response.json({
        phase: "bootstrap", cursor: "A".repeat(4135), more: false, changes: [],
        entries: [{ id: "one", revision: 1, projectId: null, parentRevision: null }],
      }) : Response.json({
        phase: "changes", cursor: "B".repeat(4135), more: false, entries: [],
        changes: [{ kind: "edit", noteId: "one", revision: 2, projectId: null }],
      });
    } });
    (globalThis as any).__first = client;
    await client.activate(scope);
    await client.pull();
    return client.read();
  }, db);
  expect(before).toEqual([{ id: "one", revision: 1, projectId: null, parentRevision: null }]);
  await page.evaluate(() => {
    (globalThis as any).__pending = (globalThis as any).__first.pull();
  });
  // Unowned second tab posts a revocation across a shared browser origin.
  await second.evaluate(async name => {
    const create = (globalThis as any).__leased.createStagingNotePersistentClient;
    (globalThis as any).__second = create({ dbName: name });
    await (globalThis as any).__second.clear();
  }, db);
  await expect.poll(() => page.evaluate(() => (globalThis as any).__first.read()),
    { timeout: 10000 }).toEqual([]);
  const late = await page.evaluate(async () => {
    (globalThis as any).__release();
    const outcome = await (globalThis as any).__pending;
    return { kind: outcome.kind, read: (globalThis as any).__first.read() };
  });
  expect(["superseded", "storage_error"]).toContain(late.kind);
  expect(late.read).toEqual([]);
  await expect.poll(async () => page.evaluate(async name => {
    const Storage = (globalThis as any).__leased.IndexedDbTargetSyncStorage;
    return (await new Storage(name).listNamespaces()).length;
  }, db), { timeout: 10000 }).toBe(0);
  await second.close();
});
