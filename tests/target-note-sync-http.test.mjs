import test from "node:test";
import assert from "node:assert/strict";
import { createStagingNoteHttpClient } from "../lib/target-sync/note-http.ts";

const C = "A".repeat(4135);
const D = "B".repeat(4135);
const scope = (userId = "alice", areaId = "personal", restoreGeneration = "123e4567-e89b-42d3-a456-426614174000") =>
  ({ userId, areaId, restoreGeneration });
const note = (id, revision = 1) => ({ id, revision, projectId: null, parentRevision: null });
const boot = (entries, more = false, cursor = C) =>
  ({ phase: "bootstrap", entries, changes: [], more, cursor });
const change = (changes, more = false, cursor = D) =>
  ({ phase: "changes", entries: [], changes, more, cursor });
const edit = (noteId, revision) => ({ kind: "edit", noteId, revision, projectId: null });
const del = (noteId, revision) => ({ kind: "delete", noteId, revision, projectId: null });
const json = (obj, status = 200) => Response.json(obj, { status });
const make = (...answers) => {
  const calls = [];
  const client = createStagingNoteHttpClient(async (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (typeof answer === "function") return answer(url, init);
    if (!answer) throw Error("Unexpected HTTP request");
    return answer;
  });
  return { client, calls };
};
const applied = result => assert.equal(result.kind, "applied", JSON.stringify(result));

test("paginates a content-free bootstrap, only publishes the final page, then applies changes", async () => {
  const { client, calls } = make(
    json(boot([note("a")], true)),
    json(boot([note("b")], false, D)),
    json(change([edit("a", 2), del("b", 2)])),
  );
  client.activate(scope());
  applied(await client.pull());
  assert.deepEqual(client.read(), [], "incomplete bootstrap is unreadable");
  applied(await client.pull());
  assert.deepEqual(client.read(), [note("a"), note("b")]);
  applied(await client.pull());
  assert.deepEqual(client.read(), [note("a", 2)]);
  assert.deepEqual(calls.map(c => new URL(c.url, "https://localhost").searchParams.get("cursor")),
    [null, C, D]);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith("/api/target-staging/note-sync?"));
    assert.equal(new URL(url, "https://localhost").searchParams.get("areaId"), "personal");
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.accept, "application/json");
    assert.ok(init.signal);
  }
});

test("stale release retries only once using the identical cursor", async () => {
  const { client, calls } = make(json(boot([note("n")])),
    json({ code: "read_stale_reload" }, 409),
    json(change([edit("n", 2)])));
  client.activate(scope());
  applied(await client.pull());
  applied(await client.pull());
  assert.deepEqual(client.read(), [note("n", 2)]);
  assert.equal(calls[1].url, calls[2].url);
  assert.equal(calls.length, 3);
});

test("persistent stale release is bounded and preserves state and cursor", async () => {
  const { client, calls } = make(json(boot([note("n")])),
    json({ code: "read_stale_reload" }, 409),
    json({ code: "read_stale_reload" }, 409),
    json(change([edit("n", 2)])));
  client.activate(scope());
  applied(await client.pull());
  assert.deepEqual(await client.pull(), { kind: "stale" });
  assert.deepEqual(client.read(), [note("n")]);
  applied(await client.pull());
  assert.deepEqual(client.read(), [note("n", 2)]);
  assert.equal(calls[1].url, calls[2].url);
  assert.equal(calls[2].url, calls[3].url);
});

test("server resync clears published state; next request must be cursorless", async () => {
  const { client, calls } = make(
    json(boot([note("old")])), json({ code: "resync_required" }, 409),
    json(boot([note("new")])));
  client.activate(scope());
  applied(await client.pull());
  assert.deepEqual(await client.pull(), { kind: "resync_required" });
  assert.deepEqual(client.read(), []);
  applied(await client.pull());
  assert.deepEqual(client.read(), [note("new")]);
  assert.equal(new URL(calls[2].url, "https://localhost").searchParams.has("cursor"), false);
});

test("client-detected revision gap forces resync without publishing a partial change page", async () => {
  const { client } = make(json(boot([note("old")])), json(change([edit("old", 4)])));
  client.activate(scope());
  applied(await client.pull());
  assert.deepEqual(await client.pull(), { kind: "resync_required" });
  assert.deepEqual(client.read(), []);
});

test("401 and inaccessible Area 404 both lock and erase the active cache", async () => {
  for (const status of [401, 404]) {
    const { client } = make(json(boot([note("secret")])),
      json({ error: "Denied" }, status));
    client.activate(scope());
    applied(await client.pull());
    assert.deepEqual(await client.pull(), { kind: "locked" });
    assert.deepEqual(client.read(), []);
    assert.equal(client.currentScope(), null);
    assert.deepEqual(await client.pull(), { kind: "inactive" });
  }
});

test("identity/Area/generation switch fences old in-flight HTTP response even when transport ignores abort", async () => {
  let finish;
  const deferred = new Promise(resolve => { finish = resolve; });
  const { client, calls } = make(() => deferred, json(boot([note("bob-only")])));
  client.activate(scope());
  const old = client.pull();
  client.activate(scope("bob", "shared", "123e4567-e89b-42d3-a456-426614174001"));
  assert.deepEqual(client.read(), []);
  applied(await client.pull());
  finish(json(boot([note("alice-only")])));
  assert.deepEqual(await old, { kind: "superseded" });
  assert.deepEqual(client.read(), [note("bob-only")]);
  assert.equal(new URL(calls[0].url, "https://localhost").searchParams.get("areaId"), "personal");
  assert.equal(new URL(calls[1].url, "https://localhost").searchParams.get("areaId"), "shared");
  const readScope = client.currentScope();
  readScope.userId = "tampered";
  assert.equal(client.currentScope().userId, "bob");
});

test("logout prevents an old success from resurrecting cached metadata", async () => {
  let finish;
  const { client } = make(() => new Promise(resolve => { finish = resolve; }));
  client.activate(scope());
  const old = client.pull();
  client.clear();
  finish(json(boot([note("secret")])));
  assert.deepEqual(await old, { kind: "superseded" });
  assert.deepEqual(client.read(), []);
  assert.equal(client.currentScope(), null);
});

test("a second concurrent request is refused without an extra fetch", async () => {
  let finish;
  const { client, calls } = make(() => new Promise(resolve => { finish = resolve; }));
  client.activate(scope());
  const a = client.pull();
  assert.deepEqual(await client.pull(), { kind: "busy" });
  finish(json(boot([note("a")])));
  applied(await a);
  assert.equal(calls.length, 1);
});

test("malformed JSON, extra content, oversized response and invalid 409 never advance a cursor", async () => {
  const giant = new Response(" ".repeat(256 * 1024 + 1), {
    headers: { "content-type": "application/json" },
  });
  const { client, calls } = make(
    json(boot([note("n")])),
    json({ ...change([]), title: "not metadata" }),
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    giant,
    json({ code: "other" }, 409),
    json(change([edit("n", 2)])),
  );
  client.activate(scope());
  applied(await client.pull());
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await client.pull(), { kind: "invalid_response" });
    assert.deepEqual(client.read(), [note("n")]);
  }
  applied(await client.pull());
  assert.deepEqual(client.read(), [note("n", 2)]);
  for (const call of calls.slice(1)) assert.equal(
    new URL(call.url, "https://localhost").searchParams.get("cursor"), C);
});

test("network failures and 503 preserve state for bounded caller retry", async () => {
  const { client } = make(json(boot([note("n")])),
    () => { throw Error("Offline"); },
    json({ error: "unavailable" }, 503), json(change([])));
  client.activate(scope());
  applied(await client.pull());
  assert.deepEqual(await client.pull(), { kind: "retry" });
  assert.deepEqual(await client.pull(), { kind: "retry" });
  assert.deepEqual(client.read(), [note("n")]);
  applied(await client.pull());
});

test("scope must be valid and comes from trusted caller, never the feed response", () => {
  const { client } = make();
  for (const candidate of [
    scope(""), scope("alice", ".."), scope("alice", "line" + String.fromCharCode(10)),
    scope("alice", "x", "not-a-uuid"), null,
  ]) assert.throws(() => client.activate(candidate), TypeError);
  assert.equal(client.currentScope(), null);
});
