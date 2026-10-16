import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";
import { integrationToken, sessionFile } from "../playwright.config";

// Gate D data boundary. The handlers are listed from the file system, so a new endpoint is checked without editing this
// file: without a session every handler must refuse (401 or 403) unless it is listed below as public with its reason;
// a request from another origin must not get through to any handler that writes; data files are never served as static
// files; and the backup, export and import endpoints refuse the integration API token.
// The owner is the only account of an instance: an export holds every workspace of the owner and nothing of anyone else.

const root = path.resolve(__dirname, "..", "app", "api");
const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) return routeFiles(file);
    return name === "route.ts" ? [file] : [];
  });
}
const handlers = routeFiles(root).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  const url = "/api/" + path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean).join("/").replace(/\[[^\]]+\]/g, "x");
  const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]
    .map((match) => match[1] ?? match[2]);
  return methods.map((method) => ({ url: url.replace(/\/$/, ""), method, key: `${method} ${url.replace(/\/$/, "")}` }));
});

// Handlers that answer without a session, with the statuses they may give to an empty request and why.
const publicHandlers: Record<string, { statuses: number[]; reason: string; contentType?: string }> = {
  "GET /api/auth/status": { statuses: [200], reason: "tells the sign-in screen whether a session exists; no data" },
  "POST /api/auth/login": { statuses: [400, 401, 429], reason: "the password sign-in itself" },
  "POST /api/auth/logout": { statuses: [200], reason: "ends a session; harmless without one" },
  "POST /api/auth/passkeys/login/options": { statuses: [400, 404, 429], reason: "starts a passkey sign-in" },
  "POST /api/auth/passkeys/login/verify": { statuses: [400, 401, 429], reason: "finishes a passkey sign-in" },
  // Probed with a body of the wrong type: a well-formed report would be recorded, and the run fails on recorded reports.
  "POST /api/client-errors": { statuses: [415, 429], reason: "a browser reports an error, also from the sign-in screen; bounded and rate limited", contentType: "text/plain" },
  "GET /api/integrations/aifred/openapi": { statuses: [200], reason: "the public description of the integration API; no data" },
};
// Handlers that authenticate with the integration bearer token instead of the session cookie.
const bearerHandlers = new Set(["POST /api/integrations/aifred", "POST /api/integrations/aifred/tools"]);

const addressOf = (name: string) => {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `10.${(hash >>> 16) & 255}.${(hash >>> 8) & 255}.${(hash & 255) || 1}`;
};

async function client(baseURL: string, name: string, options: { session?: boolean; token?: boolean } = {}) {
  return playwrightRequest.newContext({
    baseURL,
    storageState: options.session ? sessionFile : undefined,
    extraHTTPHeaders: { "x-forwarded-for": addressOf(name), ...(options.token ? { authorization: `Bearer ${integrationToken}` } : {}) },
  });
}
const send = (context: APIRequestContext, method: string, url: string, headers: Record<string, string> = {}, contentType = "application/json") =>
  context.fetch(url, { method, headers: mutating.has(method) ? { "content-type": contentType, ...headers } : headers, data: mutating.has(method) ? "{}" : undefined, maxRedirects: 0 });

test("the handler list is generated from the file system", () => {
  const keys = handlers.map((handler) => handler.key);
  expect(keys.length).toBeGreaterThan(30);
  for (const key of ["GET /api/backups", "POST /api/backups", "GET /api/backups/export", "POST /api/backups/import", "GET /api/store", "PUT /api/store"]) expect(keys).toContain(key);
  for (const key of Object.keys(publicHandlers)) expect(keys, `${key} is listed as public but does not exist`).toContain(key);
  for (const key of bearerHandlers) expect(keys, `${key} is listed as bearer-only but does not exist`).toContain(key);
});

test("without a session every handler refuses, except the documented public ones", async ({ baseURL }) => {
  const anonymous = await client(baseURL!, "anonymous");
  const failures: string[] = [];
  for (const { key, method, url } of handlers) {
    const publicRule = publicHandlers[key];
    const response = await send(anonymous, method, url, { origin: baseURL! }, publicRule?.contentType);
    const allowed = publicRule ? publicRule.statuses : [401, 403];
    if (!allowed.includes(response.status())) failures.push(`${key} answered ${response.status()}, expected ${allowed.join(" or ")}`);
    if (!publicRule && response.status() === 200) failures.push(`${key} answered 200 without a session`);
  }
  expect(failures).toEqual([]);
  await anonymous.dispose();
});

test("a request from another origin, or with none, does not get through to a handler that writes", async ({ baseURL }) => {
  const owner = await client(baseURL!, "cross-origin", { session: true });
  const failures: string[] = [];
  for (const { key, method, url } of handlers) {
    if (!mutating.has(method) || bearerHandlers.has(key)) continue;
    for (const headers of [{ origin: "https://evil.example" }, {}] as Array<Record<string, string>>) {
      const response = await send(owner, method, url, headers);
      if (response.status() !== 403) failures.push(`${key} with ${headers.origin ?? "no origin"} answered ${response.status()}, expected 403`);
    }
  }
  expect(failures).toEqual([]);
  // The same session from the instance's own origin is accepted by the owner-only endpoints (the check is not a blanket refusal).
  const own = await send(owner, "GET", "/api/backups", { origin: baseURL! });
  expect(own.status()).toBe(200);
  await owner.dispose();
});

test("backup, export and import files and data files are not served as static files", async ({ baseURL }) => {
  const owner = await client(baseURL!, "static-owner", { session: true });
  const anonymous = await client(baseURL!, "static-anonymous");
  // Real backup files exist when this runs.
  const created = await owner.post("/api/backups", { headers: { origin: baseURL!, "content-type": "application/json" }, data: { action: "create" } });
  expect(created.status()).toBe(200);
  const list = (await (await owner.get("/api/backups")).json()).backups as Array<{ name: string }>;
  expect(list.length).toBeGreaterThan(0);
  const names = list.slice(0, 3).map((backup) => backup.name);
  const metas = names.filter((name) => name.endsWith(".sqlite")).map((name) => name.replace(/\.sqlite$/, ".meta.json"));
  const paths = [
    "/.data/store.sqlite", "/.data/store.sqlite-wal", "/.data/backups", "/.data/tmp", "/store.sqlite", "/store.sqlite-shm", "/store.json", "/data.sqlite", "/backup.sqlite",
    "/.env", "/.env.local", "/.env.production", "/export.zip", "/lumi-export.zip", "/database.sqlite", "/manifest.json",
    "/backups", "/tmp/export.zip",
    ...[...names, ...metas].flatMap((name) => [`/${name}`, `/backups/${name}`, `/.data/backups/${name}`, `/api/backups/${name}`, `/_next/static/${name}`]),
  ];
  const failures: string[] = [];
  for (const context of [anonymous, owner]) {
    for (const target of paths) {
      const response = await context.get(target, { maxRedirects: 0 });
      const body = await response.body();
      if (response.status() !== 404) failures.push(`${target} answered ${response.status()}`);
      if (body.subarray(0, 15).toString("latin1").startsWith("SQLite format 3") || body.subarray(0, 2).toString("latin1") === "PK") failures.push(`${target} served data`);
    }
  }
  expect(failures).toEqual([]);
  await owner.dispose();
  await anonymous.dispose();
});

test("the backup, export and import endpoints refuse the integration API token", async ({ baseURL }) => {
  // The token is valid: the integration endpoint it is meant for accepts it (an invalid request, not a refused one).
  const bearer = await client(baseURL!, "bearer", { token: true });
  const accepted = await bearer.post("/api/integrations/aifred", { headers: { origin: baseURL!, "content-type": "application/json" }, data: {} });
  expect(accepted.status()).not.toBe(401);
  const failures: string[] = [];
  const backupHandlers = handlers.filter((handler) => handler.url.startsWith("/api/backups"));
  expect(backupHandlers.length).toBeGreaterThanOrEqual(4);
  for (const { key, method, url } of backupHandlers) {
    const response = await send(bearer, method, url, { origin: baseURL! });
    if (response.status() !== 401) failures.push(`${key} with the integration token answered ${response.status()}`);
  }
  // Also on the owner-only data endpoints around them.
  for (const target of ["/api/store", "/api/context/claims?workspaceId=personal", "/api/notes/revisions?noteId=x"]) {
    const response = await bearer.get(target);
    if (response.status() !== 401) failures.push(`GET ${target} with the integration token answered ${response.status()}`);
  }
  expect(failures).toEqual([]);
  await bearer.dispose();
});

test("an export holds every workspace of the owner, and is given only to the owner's session", async ({ baseURL, page }) => {
  await page.goto("/");
  const second = `e2e-boundary-ws-${Date.now()}`;
  const marker = `e2e-boundary-note-${Date.now()}`;
  await page.evaluate(async ([workspaceId, noteId]) => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    const now = Date.now();
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: [...snapshot.entities,
        { id: `workspace:${workspaceId}`, type: "workspace", title: "Boundary", status: "active", workspaceId, properties: { kind: "personal", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now },
        { id: noteId, type: "note", title: "Boundary note", content: "x", status: "active", workspaceId, properties: {}, createdAt: now, updatedAt: now }],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  }, [second, marker]);
  try {
    const owner = await client(baseURL!, "export-owner", { session: true });
    const bearer = await client(baseURL!, "export-bearer", { token: true });
    const anonymous = await client(baseURL!, "export-anonymous");
    expect((await anonymous.get("/api/backups/export")).status()).toBe(401);
    expect((await bearer.get("/api/backups/export")).status()).toBe(401);
    // A page of another site cannot start the download with the owner's cookie.
    expect((await owner.get("/api/backups/export", { headers: { origin: "https://evil.example" } })).status()).toBe(403);
    const response = await owner.get("/api/backups/export", { headers: { origin: baseURL! } });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["content-type"]).toBe("application/zip");
    expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="lumi-export-[^"/\\]+\.zip"$/);
    const entries = unzipSync(new Uint8Array(await response.body()));
    const payloads = (JSON.parse(Buffer.from(entries["data/entities.json"]).toString("utf8")) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as { id: string; workspaceId: string });
    expect(payloads.some((entity) => entity.id === marker && entity.workspaceId === second)).toBe(true);
    expect(payloads.some((entity) => entity.id === `workspace:${second}`)).toBe(true);
    expect(payloads.some((entity) => entity.workspaceId === "personal")).toBe(true);
    // Nothing that is not owner data: no passkeys, push endpoints, security log or secrets.
    const everything = Object.values(entries).map((bytes) => Buffer.from(bytes).toString("latin1")).join("\n");
    expect(everything).not.toContain("vapidKeys");
    for (const name of Object.keys(entries)) expect(name).not.toMatch(/passkey|push_subscriptions|security_/);
    await Promise.all([owner.dispose(), bearer.dispose(), anonymous.dispose()]);
  } finally {
    await page.evaluate(async ([workspaceId, noteId]) => {
      const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
      const gone = [`workspace:${workspaceId}`, noteId];
      await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
        entities: snapshot.entities.filter((entity: { id: string }) => !gone.includes(entity.id)), relations: snapshot.relations, deletedIds: gone, revivedIds: [] }) });
    }, [second, marker]);
  }
});
