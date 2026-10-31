import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

// Execute the real TypeScript client and IndexedDB adapter inside Chromium.
// R2c.5b does not activate the new adapter in the production UI.
const sourceFiles = ["storage.ts", "indexeddb.ts", "client.ts", "fake.ts"];
function compile(file: string): string {
  const source = readFileSync(resolve(process.cwd(), "lib/target-sync", file), "utf8");
  const js = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
    .replace(/^\s*import[^;\n]+from ["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+\{\s*\};?/g, "")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:class|const|function)\b)/g, "");
  // Catch future runtime exports/imports that the small browser harness does not support.
  if (/^\s*(?:import|export)\s/m.test(js)) throw new Error("Unexpected module syntax in " + file);
  return js;
}

// The contract-model fake server uses Buffer exclusively for base64url cursors.
const browserPrelude = [
  "const setImmediate = callback => setTimeout(callback, 0);",
  "const Buffer = { from(value, encoding) {",
  "  if (encoding === 'base64url') {",
  "    const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));",
  "    const data = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));",
  "    return { toString: () => data };",
  "  }",
  "  const bytes = new TextEncoder().encode(String(value));",
  "  return { toString: format => format === 'base64url'",
  "    ? btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')",
  "    : String(value) };",
  "} };",
].join("\n");
const browserSource = "(function () {\n" + browserPrelude + "\n" +
  sourceFiles.map(compile).join("\n") +
  "\nglobalThis.__lumiSync = { IndexedDbTargetSyncStorage, TargetSyncClient, FakeTargetServer };\n})();";

async function harness(page: Page): Promise<void> {
  await page.goto("/");
  await page.addScriptTag({ content: browserSource });
}

test("prefix reads, prefix deletes and namespace wipes include extreme Unicode keys", async ({ page }) => {
  await harness(page);
  const output = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage } = (globalThis as any).__lumiSync;
    const store = new Storage("lumi-indexeddb-e2e-" + crypto.randomUUID());
    const a = await store.openNamespace("alice");
    const b = await store.openNamespace("bob");
    await a.transaction([
      { kind: "put", key: "a", value: 1 },
      { kind: "put", key: "a\ufffftail", value: 2 },
      { kind: "put", key: "a\udbff\udfff", value: 3 },
      { kind: "put", key: "\ufffftail", value: 4 },
      { kind: "put", key: "z", value: 5 },
    ]);
    await b.transaction([{ kind: "put", key: "safe", value: 10 }]);
    const matches = (await a.list("a")).map((entry: any) => entry.key);
    await a.transaction([{ kind: "deletePrefix", prefix: "a" }]);
    const remaining = (await a.list("")).map((entry: any) => entry.key);
    await store.deleteNamespaces(["alice"]);
    const staleGetRejected = await a.get("z").then(() => false, () => true);
    const staleListRejected = await a.list("").then(() => false, () => true);
    const staleWriteRejected = await a.transaction([{ kind: "put", key: "x", value: 1 }])
      .then(() => false, () => true);
    const reopened = await store.openNamespace("alice");
    return { matches, remaining, staleGetRejected, staleListRejected, staleWriteRejected,
      newRecords: await reopened.list(""), bobValue: await b.get("safe"),
      namespaces: await store.listNamespaces() };
  });
  expect(output.matches).toEqual(["a", "a\udbff\udfff", "a\ufffftail"]);
  expect(output.remaining).toEqual(["z", "\ufffftail"]);
  expect([output.staleGetRejected, output.staleListRejected, output.staleWriteRejected])
    .toEqual([true, true, true]);
  expect(output.newRecords).toEqual([]);
  expect(output.bobValue).toBe(10);
  expect(output.namespaces).toEqual(["alice", "bob"]);
});

test("failed multi-operation transaction rolls back; values survive storage reopen as copies", async ({ page }) => {
  await harness(page);
  const output = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage } = (globalThis as any).__lumiSync;
    const dbName = "lumi-indexeddb-e2e-" + crypto.randomUUID();
    const store = new Storage(dbName);
    const ns = await store.openNamespace("owner");
    await ns.transaction([{ kind: "put", key: "draft/1", value: { title: "unsent" } }]);
    const failed = await ns.transaction([
      { kind: "put", key: "cmd/1", value: { state: "sending" } },
      { kind: "put", key: "bad", value: () => 1 },
    ]).then(() => false, () => true);
    const fresh = await new Storage(dbName).openNamespace("owner");
    const mutated = await fresh.get("draft/1");
    mutated.title = "modified outside storage";
    return { failed, rolledBack: await fresh.get("cmd/1"),
      unchanged: await fresh.get("draft/1"), list: await fresh.list("draft/") };
  });
  expect(output.failed).toBe(true);
  expect(output.rolledBack).toBeUndefined();
  expect(output.unchanged).toEqual({ title: "unsent" });
  expect(output.list).toEqual([{ key: "draft/1", value: { title: "unsent" } }]);
});

test("persistent IndexedDB client resumes a queued draft without repeating bootstrap", async ({ page }) => {
  await harness(page);
  const output = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage, TargetSyncClient: Client, FakeTargetServer: Server } =
      (globalThis as any).__lumiSync;
    const dbName = "lumi-indexeddb-e2e-" + crypto.randomUUID();
    const server = new Server("11111111-1111-4111-8111-111111111111");
    server.addUser("alice");
    server.addArea("team", { alice: "admin" });
    server.addTask("t1", "team", "initial");
    const transport = server.transport(server.login("alice"));
    const first = new Client({ storage: new Storage(dbName), transport, autoRun: false });
    await first.activate({ userId: "alice" });
    await first.sync();
    await first.editTitle("t1", "offline edit");
    const before = server.calls.filter((c: any) => c.method === "fetchChanges" && c.cursor === null).length;
    const second = new Client({ storage: new Storage(dbName), transport, autoRun: false });
    await second.activate({ userId: "alice" });
    const draftTitles = (await second.listDrafts()).value.map((d: any) => d.title);
    await second.sync();
    const after = server.calls.filter((c: any) => c.method === "fetchChanges" && c.cursor === null).length;
    await second.pump();
    return { before, after, draftTitles, serverTitle: server.tasks.get("t1").title,
      writes: server.writes.length, draftsAfter: (await second.listDrafts()).value };
  });
  expect(output.before).toBe(1);
  expect(output.after).toBe(1);
  expect(output.draftTitles).toEqual(["offline edit"]);
  expect(output.serverTitle).toBe("offline edit");
  expect(output.writes).toBe(1);
  expect(output.draftsAfter).toEqual([]);
});

test("restore generation retains reviewable drafts without resending old commands", async ({ page }) => {
  await harness(page);
  const output = await page.evaluate(async () => {
    const { IndexedDbTargetSyncStorage: Storage, TargetSyncClient: Client, FakeTargetServer: Server } =
      (globalThis as any).__lumiSync;
    const oldGen = "11111111-1111-4111-8111-111111111111";
    const newGen = "22222222-2222-4222-8222-222222222222";
    const dbName = "lumi-indexeddb-e2e-" + crypto.randomUUID();
    const server = new Server(oldGen);
    server.addUser("alice");
    server.addArea("team", { alice: "admin" });
    server.addTask("t1", "team", "original");
    const transport = server.transport(server.login("alice"));
    const before = new Client({ storage: new Storage(dbName), transport, autoRun: false });
    await before.activate({ userId: "alice" });
    await before.sync();
    await before.editTitle("t1", "old unsent draft");
    server.restore({ generation: newGen, tasks: [["t1", "team", "restored"]] });
    const storage = new Storage(dbName);
    const after = new Client({ storage, transport, autoRun: false });
    await after.activate({ userId: "alice", restoreGeneration: newGen });
    await after.sync();
    await after.pump();
    return { serverTitle: server.tasks.get("t1").title, writes: server.writes.length,
      namespaces: await storage.listNamespaces(), drafts: (await after.listDrafts()).value };
  });
  expect(output.serverTitle).toBe("restored");
  expect(output.writes).toBe(0);
  expect(output.namespaces).toEqual(["lumi-sync-v1|alice|22222222-2222-4222-8222-222222222222"]);
  expect(output.drafts).toHaveLength(1);
  expect(output.drafts[0].title).toBe("old unsent draft");
});
