import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const { serverErrorKeys, developerOnly, localizeServerError } = await import("../lib/server-errors.ts");
const { copy } = await import("../app/ui/copy.ts");

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// Every error message the server code can send, as written in lib/ and app/api/.
const messages = new Set();
for (const file of [...files("lib"), ...files("app/api")]) {
  if (file.endsWith("server-errors.ts")) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:HttpInputError|new Error)\(\s*"((?:[^"\\]|\\.)*)"|\berror:\s*"((?:[^"\\]|\\.)*)"/g)) messages.add(match[1] ?? match[2]);
}

test("every server error message is either translated or classified as developer-only", () => {
  const unclassified = [...messages].filter((message) => !(message in serverErrorKeys) && !developerOnly.has(message));
  assert.deepEqual(unclassified, []);
  assert.deepEqual([...developerOnly].filter((message) => message in serverErrorKeys), []);
  assert.deepEqual(Object.keys(serverErrorKeys).filter((message) => !messages.has(message)), []);
});

test("translated server messages exist in both languages and keep the English text", () => {
  for (const [message, key] of Object.entries(serverErrorKeys)) {
    assert.equal(copy.en[key], message, key);
    assert.ok(copy.cs[key] && copy.cs[key] !== message, key);
  }
});

test("a server message is shown translated, an unknown one as it is", () => {
  const tr = (key) => copy.cs[key] || key;
  assert.equal(localizeServerError("Calendar URL must use HTTPS", tr), copy.cs.serverError_calendarUrlMustUseHttps);
  assert.equal(localizeServerError("Something new", tr), "Something new");
  assert.equal(localizeServerError(undefined, tr), "");
});
