import assert from "node:assert/strict";
import { test } from "node:test";

const { createFetchTransport } = await import("../lib/target-sync/fetch-transport.ts");

// R2c.5a: the fetch transport maps every response of the staging routes to ONE typed result.
const respond = (status, body, headers = {}) => async () => new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const request = { taskId: "t/1 x", commandId: "00000000-0000-4000-8000-000000000001", expectedRevision: "a".repeat(64), writeAreaId: "team", restoreGeneration: "11111111-1111-4111-8111-111111111111" };
const page = { phase: "feed", items: [], more: false, cursor: "c", restoreGeneration: request.restoreGeneration };

test("write requests carry the protocol header, same-origin credentials and the exact route body", async () => {
  const seen = [];
  const transport = createFetchTransport({ fetch: async (url, init) => { seen.push([url, init]); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });
  await transport.sendTitle({ ...request, title: "T" });
  await transport.sendDelete(request);
  await transport.titleStatus({ ...request, title: "T" });
  await transport.deleteStatus(request);
  assert.deepEqual(seen.map(([url, init]) => [init.method, url]), [
    ["PATCH", "/api/target-staging/tasks/t%2F1%20x/title"],
    ["POST", "/api/target-staging/tasks/t%2F1%20x/delete"],
    ["POST", "/api/target-staging/tasks/t%2F1%20x/title/status"],
    ["POST", "/api/target-staging/tasks/t%2F1%20x/delete/status"],
  ]);
  for (const [, init] of seen) {
    assert.equal(init.headers["x-lumi-target-protocol"], "1");
    assert.equal(init.credentials, "same-origin");
  }
  assert.deepEqual(Object.keys(JSON.parse(seen[0][1].body)).sort(), ["commandId", "expectedRevision", "restoreGeneration", "title", "writeAreaId"]);
  assert.deepEqual(Object.keys(JSON.parse(seen[1][1].body)).sort(), ["commandId", "expectedRevision", "restoreGeneration", "writeAreaId"]);
  assert.equal(JSON.parse(seen[0][1].body).taskId, undefined, "task id only in the URL");
});

test("reads: changes with and without cursor, CAS token read", async () => {
  const urls = [];
  const transport = createFetchTransport({ baseUrl: "/x/", fetch: async url => { urls.push(url); return new Response(JSON.stringify(url.includes("/title") ? { snapshotRevision: "r" } : page), { status: 200 }); } });
  assert.equal((await transport.fetchChanges(null)).kind, "ok");
  assert.equal((await transport.fetchChanges("a b")).kind, "ok");
  assert.deepEqual((await transport.readTitleToken("t")).value, { snapshotRevision: "r" });
  assert.deepEqual(urls, ["/x/changes", "/x/changes?cursor=a%20b", "/x/tasks/t/title"]);
});

const table = [
  ["200 ok", 200, { ok: true }, {}, { kind: "ok" }],
  ["200 replayed", 200, { ok: true, replayed: true }, {}, { kind: "ok", replayed: true }],
  ["409 stale", 409, { error: "Revision conflict", code: "stale_revision" }, {}, { kind: "conflict", code: "stale_revision" }],
  ["409 idempotency", 409, { error: "Revision conflict", code: "idempotency_conflict" }, {}, { kind: "conflict", code: "idempotency_conflict" }],
  ["409 write area", 409, { error: "Revision conflict", code: "write_area_mismatch" }, {}, { kind: "conflict", code: "write_area_mismatch" }],
  ["409 title conflict without code", 409, { error: "Revision conflict" }, {}, { kind: "conflict", code: "unspecified" }],
  ["409 resync", 409, { error: "Resync required", code: "resync_required" }, {}, { kind: "resync_required" }],
  ["409 stale read", 409, { code: "read_stale_reload" }, {}, { kind: "read_stale_reload" }],
  ["400 cursor", 400, { code: "cursor_invalid" }, {}, { kind: "cursor_invalid" }],
  ["400 protocol", 400, { error: "Invalid request", code: "protocol_unsupported" }, {}, { kind: "invalid", code: "protocol_unsupported" }],
  ["400 plain", 400, { error: "Invalid request" }, {}, { kind: "invalid", code: null }],
  ["403 origin", 403, { error: "Cross-origin request rejected" }, {}, { kind: "invalid", code: null }],
  ["404", 404, { error: "Not found" }, {}, { kind: "unavailable" }],
  ["401 expired", 401, { error: "Authentication required", code: "session_expired" }, {}, { kind: "unauthorized", code: "session_expired" }],
  ["401 revoked", 401, { error: "Authentication required", code: "session_revoked" }, {}, { kind: "unauthorized", code: "session_revoked" }],
  ["401 restored", 401, { error: "Authentication required", code: "session_restored" }, {}, { kind: "unauthorized", code: "session_restored" }],
  ["401 without code", 401, { error: "Authentication required" }, {}, { kind: "unauthorized", code: null }],
  ["401 unknown code", 401, { code: "something_new" }, {}, { kind: "unauthorized", code: null }],
  ["503 restore_pending", 503, { error: "Staging unavailable", code: "restore_pending" }, {}, { kind: "store_unavailable", code: "restore_pending" }],
  ["503 journal_invalid", 503, { error: "Staging unavailable", code: "journal_invalid" }, {}, { kind: "store_unavailable", code: "journal_invalid" }],
  ["503 plain", 503, { error: "Staging unavailable" }, {}, { kind: "store_unavailable", code: null }],
  ["429", 429, { error: "Too many requests" }, { "retry-after": "17" }, { kind: "rate_limited", retryAfterSeconds: 17 }],
  ["429 without header", 429, { error: "Too many requests" }, {}, { kind: "rate_limited", retryAfterSeconds: null }],
  ["500", 500, { error: "boom" }, {}, { kind: "uncertain", reason: "http_500" }],
  ["502 html", 502, "<html>bad gateway</html>", {}, { kind: "uncertain", reason: "http_502" }],
];
for (const [name, status, body, headers, expected] of table) {
  test(`maps ${name}`, async () => {
    const transport = createFetchTransport({ fetch: respond(status, body, headers) });
    const result = await transport.sendDelete(request);
    assert.deepEqual({ ...result, value: undefined }, { ...expected, value: undefined });
  });
}

test("network errors, timeouts and unparseable or wrong-shaped 200 bodies are uncertain, never an ok", async () => {
  const failing = createFetchTransport({ fetch: async () => { throw new TypeError("network down"); } });
  assert.equal((await failing.sendTitle({ ...request, title: "T" })).kind, "uncertain");
  const timeout = createFetchTransport({ fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } });
  assert.deepEqual(await timeout.fetchChanges(null), { kind: "uncertain", reason: "TimeoutError" });
  const garbage = createFetchTransport({ fetch: respond(200, "not json at all") });
  assert.equal((await garbage.sendTitle({ ...request, title: "T" })).kind, "uncertain");
  assert.equal((await garbage.fetchChanges(null)).kind, "uncertain");
  const wrongFeed = createFetchTransport({ fetch: respond(200, { phase: "feed", items: "nope" }) });
  assert.equal((await wrongFeed.fetchChanges(null)).kind, "uncertain");
  const wrongStatus = createFetchTransport({ fetch: respond(200, { status: "maybe" }) });
  assert.equal((await wrongStatus.deleteStatus(request)).kind, "uncertain");
  const noOk = createFetchTransport({ fetch: respond(200, {}) });
  assert.equal((await noOk.sendDelete(request)).kind, "uncertain", "a 200 without ok:true is not a success");
});

test("status endpoints parse committed and not_recorded", async () => {
  for (const status of ["committed", "not_recorded"]) {
    const transport = createFetchTransport({ fetch: respond(200, { status }) });
    assert.deepEqual((await transport.titleStatus({ ...request, title: "T" })).value, { status });
  }
});
