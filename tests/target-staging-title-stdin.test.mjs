import assert from "node:assert/strict";
import { test } from "node:test";
import { readTitleCommand } from "../scripts/target-staging-title-stdin.mjs";

test("title command preserves UTF-8 split in the middle of multibyte characters", async () => {
  const command = { taskId: "task", title: "Café 🍵 漢字", expectedRevision: "rev" };
  const bytes = Buffer.from(JSON.stringify(command), "utf8");
  const accent = bytes.indexOf(Buffer.from("é"));
  const emoji = bytes.indexOf(Buffer.from("🍵"));
  const chunks = [
    bytes.subarray(0, accent + 1),
    bytes.subarray(accent + 1, emoji + 2),
    bytes.subarray(emoji + 2),
  ];
  assert.deepEqual(await readTitleCommand(chunks), command);
});

test("title command enforces the 32768-byte limit before decoding", async () => {
  assert.deepEqual(await readTitleCommand([Buffer.from(`{"x":"${"a".repeat(32760)}"}`)]),
    { x: "a".repeat(32760) });
  await assert.rejects(readTitleCommand([Buffer.alloc(32768, 0x20), Buffer.from("x")]), /Too large/);
});

test("title command rejects malformed UTF-8 and malformed JSON", async () => {
  await assert.rejects(readTitleCommand([Buffer.from('{"title":"'), Buffer.from([0xc3, 0x22, 0x7d])]),
    TypeError);
  await assert.rejects(readTitleCommand([Buffer.from('{"title":')]), SyntaxError);
});
