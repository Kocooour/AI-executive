import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../public/refresh-app.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test("gentle recovery removes only Albert shell caches and keeps device data", async () => {
  assert.ok(script, "recovery script exists");
  const deleted = [];
  const registrations = [{ unregister: async () => true }, { unregister: async () => true }];
  const elements = {
    title: { textContent: "" },
    status: { textContent: "" },
    "open-app": { href: "/", hidden: true },
  };
  const forbidden = new Proxy({}, { get: () => { throw new Error("device data must not be touched"); } });
  await runInNewContext(script, {
    navigator: { serviceWorker: { getRegistrations: async () => registrations } },
    window: { caches: true },
    caches: {
      keys: async () => ["ai-executive-shell-v7", "ai-executive-shell-v8", "another-app"],
      delete: async (key) => { deleted.push(key); return true; },
    },
    indexedDB: forbidden,
    localStorage: forbidden,
    document: {
      getElementById: (id) => elements[id],
      get cookie() { throw new Error("cookies must not be touched"); },
      set cookie(_value) { throw new Error("cookies must not be touched"); },
    },
    Date: { now: () => 12345 },
  });
  assert.deepEqual(deleted, ["ai-executive-shell-v7", "ai-executive-shell-v8"]);
  assert.equal(elements.title.textContent, "Obnova dokončena");
  assert.match(elements.status.textContent, /data.*passkey.*zachované/);
  assert.equal(elements["open-app"].href, "/?refresh=12345");
  assert.equal(elements["open-app"].hidden, false);
});
