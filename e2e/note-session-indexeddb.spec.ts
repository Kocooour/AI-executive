import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

/** Isolated Chromium note session checks; no real server, credentials or UI. */
function compile(filename: string): string {
  const source = readFileSync(resolve(process.cwd(), "lib/target-sync", filename), "utf8");
  const js = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
    .replace(/^\s*import[\s\S]*?from ["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+\{\s*\};?/g, "")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:class|const|function)\b)/g, "");
  if (/^\s*(?:import|export)\s/m.test(js)) throw Error("Unexpected syntax in " + filename);
  return js;
}
const common = ["storage.ts", "indexeddb.ts", "note-pages.ts", "note-http.ts"]
  .map(compile).join("\n");
const script = "(function(){\n" + common +
  "\n const IndexedDbNoteMetadataLease=(function(){\n" + compile("note-lease.ts") +
  "\n return IndexedDbNoteMetadataLease;\n})();\n" +
  compile("note-leased.ts") + "\n" + compile("note-persistent.ts") +
  "\n" + compile("note-session.ts") +
  "\n globalThis.__noteSession={createStagingNoteSessionBoundClient,IndexedDbTargetSyncStorage,decodeVerifiedNoteScope};\n})();";
async function harness(page: Page) {
  const url = "http://localhost:3101/note-session-integration";
  await page.route(url, route => route.fulfill({
    status: 200, contentType: "text/html",
    body: "<!doctype html><title>Lumi note session isolated</title>",
  }));
  await page.goto(url);
  await page.addScriptTag({ content: script });
}

test("verified session controls actor, Area, and generation; changed identity purges previous cache", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { createStagingNoteSessionBoundClient: create, IndexedDbTargetSyncStorage: Storage } =
      (globalThis as any).__noteSession;
    const db = "lumi-note-session-" + crypto.randomUUID();
    const generation = "123e4567-e89b-42d3-a456-426614174000";
    let userId = "alice";
    const client = create({
      dbName: db,
      scopeTransport: async (url: string, init: RequestInit) => {
        if (init.credentials !== "same-origin" || init.cache !== "no-store" ||
            !url.startsWith("/api/target-staging/note-sync-session?areaId="))
          throw Error("untrusted scope transport");
        return Response.json({ version: 1, scope: {
          userId, restoreGeneration: generation, areaId: "private",
        } });
      },
      transport: async () => Response.json({
        phase: "bootstrap", cursor: "A".repeat(4135),
        entries: [{ id: userId + "-note", revision: 1, projectId: null, parentRevision: null }],
        changes: [], more: false,
      }),
    });
    const activated = await client.activate("private");
    const hiddenBeforePull = client.read();
    const first = await client.pull();
    const alice = client.read();
    userId = "bob"; // actual server session changes, not a caller-supplied userId
    const changed = await client.pull();
    const hiddenAfterChange = client.read();
    const gone = await new Storage(db).listNamespaces();
    const again = await client.activate("private");
    const second = await client.pull();
    const bob = client.read();
    const remaining = await new Storage(db).listNamespaces();
    await client.dispose();
    return { activated, hiddenBeforePull, first: first.kind, alice,
      changed: changed.kind, hiddenAfterChange, gone, again,
      second: second.kind, bob, remaining };
  });
  expect(result.activated).toBe("fresh");
  expect(result.hiddenBeforePull).toEqual([]);
  expect(result.first).toBe("applied");
  expect(result.alice[0].id).toBe("alice-note");
  expect(result.changed).toBe("locked");
  expect(result.hiddenAfterChange).toEqual([]);
  expect(result.gone).toEqual([]);
  expect(result.again).toBe("fresh");
  expect(result.second).toBe("applied");
  expect(result.bob[0].id).toBe("bob-note");
  expect(result.remaining).toHaveLength(1);
  expect(result.remaining[0]).toContain("bob");
  expect(result.remaining[0]).not.toContain("alice");
});

test("session actor changes during suspended HTTP result; no late metadata publication", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { createStagingNoteSessionBoundClient: create, IndexedDbTargetSyncStorage: Storage } =
      (globalThis as any).__noteSession;
    const db = "lumi-note-session-" + crypto.randomUUID();
    let userId = "alice";
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reached: () => void = () => {};
    const holding = new Promise<void>(resolve => { reached = resolve; });
    const client = create({
      dbName: db,
      scopeTransport: async () => Response.json({ version: 1, scope: {
        userId, areaId: "private", restoreGeneration: "123e4567-e89b-42d3-a456-426614174000",
      } }),
      transport: async () => {
        calls++;
        if (calls > 1) { reached(); await gate; }
        return calls === 1 ? Response.json({
          phase: "bootstrap", cursor: "A".repeat(4135), more: false, changes: [],
          entries: [{ id: "alice-note", revision: 1, projectId: null, parentRevision: null }],
        }) : Response.json({
          phase: "changes", cursor: "B".repeat(4135), more: false, entries: [],
          changes: [{ kind: "edit", noteId: "alice-note", revision: 2, projectId: null }],
        });
      },
    });
    await client.activate("private");
    await client.pull();
    const before = client.read();
    const pending = client.pull();
    await holding;
    const during = client.read();
    userId = "bob"; // changed cookie while transport ignores cancellation
    release();
    const outcome = await pending;
    const after = client.read();
    const namespaces = await new Storage(db).listNamespaces();
    await client.dispose();
    return { before, during, outcome: outcome.kind, after, namespaces };
  });
  expect(result.before[0].id).toBe("alice-note");
  expect(result.during).toEqual([]);
  expect(result.outcome).toBe("locked");
  expect(result.after).toEqual([]);
  expect(result.namespaces).toEqual([]);
});

test("malformed or content-bearing session scope cannot authorize cached note reads", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { createStagingNoteSessionBoundClient: create,
      decodeVerifiedNoteScope: decode } = (globalThis as any).__noteSession;
    const generation = "123e4567-e89b-42d3-a456-426614174000";
    const scope = { userId: "alice", areaId: "private", restoreGeneration: generation };
    const rejects = [
      { version: 1, scope: { ...scope, noteBody: "private" } },
      { version: 1, scope: { ...scope, areaId: "shared" } },
      { version: 1, scope: { ...scope, userId: 1 } },
      { version: 1, scope, cursor: "stolen" },
      { version: 2, scope },
    ].every(v => decode(v, "private") === null);
    const client = create({
      dbName: "lumi-note-session-" + crypto.randomUUID(),
      scopeTransport: async () => Response.json({ version: 1,
        scope: { ...scope, noteTitle: "forbidden" } }),
      transport: async () => { throw Error("must not reach notes"); },
    });
    const activated = await client.activate("private");
    const read = client.read();
    const currentScope = client.currentScope();
    await client.dispose();
    return { rejects, activated, read, currentScope };
  });
  expect(result).toEqual({ rejects: true, activated: "retry", read: [], currentScope: null });
});
