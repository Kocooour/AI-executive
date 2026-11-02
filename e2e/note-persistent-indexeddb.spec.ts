import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

/** Focused Chromium integration: production IndexedDB adapter + note checkpoint
 * controller, never a UI E2E or production account. */
const files = ["storage.ts", "indexeddb.ts", "note-pages.ts", "note-http.ts", "note-persistent.ts"];
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
const script = "(function () {\n" + files.map(compile).join("\n") +
  "\n globalThis.__noteClient = { IndexedDbTargetSyncStorage, createStagingNotePersistentClient, noteMetadataNamespace }; \n})();";

async function harness(page: Page) {
  const url = "http://localhost:3101/note-cache-browser";
  await page.route(url, route => route.fulfill({ status: 200,
    contentType: "text/html", body: "<!doctype html><title>Lumi note metadata cache</title>" }));
  await page.goto(url);
  await page.addScriptTag({ content: script });
}

test("real IndexedDB writes cursor and manifest together; restart hidden until fresh HTTP verification", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage, createStagingNotePersistentClient: create } =
      (globalThis as any).__noteClient;
    const db = "lumi-note-test-" + crypto.randomUUID();
    const scope = { userId: "alice", areaId: "area-1", restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const C = "A".repeat(4135), D = "B".repeat(4135);
    const n = (id: string, revision = 1) => ({ id, revision, projectId: null, parentRevision: null });
    const first = create({ storage: new Storage(db),
      transport: async () => Response.json({ phase: "bootstrap", entries: [n("one")],
        changes: [], cursor: C, more: false }) });
    await first.activate(scope);
    const a = await first.pull();
    const shown = first.read();
    const reopened = create({ storage: new Storage(db),
      transport: async (url: string) => {
        if (new URL(url, "https://localhost").searchParams.get("cursor") !== C)
          throw Error("lost persisted cursor");
        return Response.json({ phase: "changes", entries: [],
          changes: [{ kind: "edit", noteId: "one", revision: 2, projectId: null }],
          cursor: D, more: false });
      } });
    const resumed = await reopened.activate(scope);
    const hidden = reopened.read();
    const b = await reopened.pull();
    const updated = reopened.read();
    const ns = await new Storage(db).listNamespaces();
    await reopened.clear();
    const gone = await new Storage(db).listNamespaces();
    return { a, shown, resumed, hidden, b, updated, ns: ns.length, gone };
  });
  expect(result.a.kind).toBe("applied");
  expect(result.shown).toEqual([{ id: "one", revision: 1, projectId: null, parentRevision: null }]);
  expect(result.resumed).toBe("restored_unverified");
  expect(result.hidden).toEqual([]);
  expect(result.b.kind).toBe("applied");
  expect(result.updated).toEqual([{ id: "one", revision: 2, projectId: null, parentRevision: null }]);
  expect(result.ns).toBe(1);
  expect(result.gone).toEqual([]);
});

test("real IndexedDB isolation wipes prior actor on replacement and on denied HTTP", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage, createStagingNotePersistentClient: create } =
      (globalThis as any).__noteClient;
    const db = "lumi-note-test-" + crypto.randomUUID();
    const generation = "123e4567-e89b-42d3-a456-426614174000";
    const alice = { userId: "alice", restoreGeneration: generation, areaId: "A|private" };
    const bob = { userId: "bob", restoreGeneration: generation, areaId: "B|private" };
    const C = "A".repeat(4135);
    const first = create({ storage: new Storage(db), transport: async () => Response.json({
      phase: "bootstrap", entries: [{ id: "private-note", revision: 1, projectId: null, parentRevision: null }],
      changes: [], more: false, cursor: C,
    }) });
    await first.activate(alice);
    await first.pull();
    await first.activate(bob);
    const wiped = await new Storage(db).listNamespaces();
    const hidden = first.read();
    const second = create({ storage: new Storage(db),
      transport: async () => Response.json({ error: "Not found" }, { status: 404 }) });
    await second.activate(bob);
    const denied = await second.pull();
    const gone = await new Storage(db).listNamespaces();
    return { wiped, hidden, denied, gone };
  });
  expect(result.wiped).toHaveLength(1);
  expect(result.wiped[0]).toContain("bob");
  expect(result.hidden).toEqual([]);
  expect(result.denied).toEqual({ kind: "locked" });
  expect(result.gone).toEqual([]);
});


test("real IndexedDB never exposes a newer manifest before the second transaction commits", async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage,
      createStagingNotePersistentClient: create, noteMetadataNamespace } =
      (globalThis as any).__noteClient;
    const db = "lumi-note-test-" + crypto.randomUUID();
    const scope = { userId: "alice", areaId: "A", restoreGeneration: "123e4567-e89b-42d3-a456-426614174000" };
    const firstNote = { id: "one", revision: 1, projectId: null, parentRevision: null };
    const C = "A".repeat(4135), D = "B".repeat(4135);
    const base = new Storage(db);
    let armed = false;
    let unblock: () => void = () => {};
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let signal: () => void = () => {};
    const reached = new Promise<void>(resolve => { signal = resolve; });
    const storage = {
      listNamespaces: () => base.listNamespaces(),
      deleteNamespaces: (names: string[]) => base.deleteNamespaces(names),
      openNamespace: async (name: string) => {
        const handle = await base.openNamespace(name);
        return {
          name: handle.name,
          get: (key: string) => handle.get(key),
          list: (prefix: string) => handle.list(prefix),
          transaction: async (ops: any[]) => {
            if (armed) {
              armed = false;
              signal();
              await gate;
            }
            return handle.transaction(ops);
          },
        };
      },
    };
    let calls = 0;
    const client = create({ storage, transport: async () => {
      calls++;
      return calls === 1
        ? Response.json({ phase: "bootstrap", entries: [firstNote],
            changes: [], more: false, cursor: C })
        : Response.json({ phase: "changes", entries: [],
            changes: [{ kind: "edit", noteId: "one", projectId: null, revision: 2 }],
            more: false, cursor: D });
    } });
    await client.activate(scope);
    await client.pull();
    armed = true;
    const pending = client.pull();
    await reached;
    const before = client.read();
    const handle = await new Storage(db).openNamespace(noteMetadataNamespace(scope));
    const savedBefore = await handle.get("checkpoint");
    unblock();
    const afterPull = await pending;
    const after = client.read();
    const savedAfter = await handle.get("checkpoint");
    await client.clear();
    return { before, cursorBefore: savedBefore.state.cursor,
      savedBefore: savedBefore.state.visible, afterPull, after,
      cursorAfter: savedAfter.state.cursor, savedAfter: savedAfter.state.visible };
  });
  expect(result.before).toEqual([{ id: "one", revision: 1, projectId: null, parentRevision: null }]);
  expect(result.savedBefore).toEqual(result.before);
  expect(result.cursorBefore).toBe("A".repeat(4135));
  expect(result.afterPull.kind).toBe("applied");
  expect(result.after).toEqual([{ id: "one", revision: 2, projectId: null, parentRevision: null }]);
  expect(result.savedAfter).toEqual(result.after);
  expect(result.cursorAfter).toBe("B".repeat(4135));
});
