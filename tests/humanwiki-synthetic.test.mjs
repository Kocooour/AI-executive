import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSyntheticBundle, advanceSyntheticImport } from "../scripts/humanwiki-synthetic/ingest.mjs";
import { ensurePrivateCheckpointDirectory, writeCheckpointAtomic } from "../scripts/humanwiki-synthetic/checkpoint.mjs";

const fixture = name => JSON.parse(readFileSync(new URL(`../scripts/humanwiki-synthetic/fixtures/${name}.json`, import.meta.url), "utf8"));

test("ChatGPT fixture retains direct, quote, and assistant provenance without confirming facts", () => {
  const parsed = parseSyntheticBundle(fixture("chatgpt"));
  const state = advanceSyntheticImport(parsed);
  assert.equal(state.next_message, 2);
  assert.deepEqual(state.records.map(item => item.provenance),
    ["owner_statement", "quoted_third_party", "assistant_generated"]);
  assert.deepEqual(state.records.map(item => item.locator.segment), [0, 1, 0]);
  assert.deepEqual(state.records.map(item => item.speaker), ["user", "unknown", "assistant"]);
  assert.equal(state.records[1].enclosing_message_speaker, "user");
  assert.ok(state.records.every(item => item.review === "proposed" && item.sensitivity === "unclassified" &&
    item.scope === "owner_private_unassigned"));
  assert.ok(state.records.every(item => !Object.hasOwn(item, "claim_id")));
  assert.notEqual(state.records[0].id, state.records[1].id);
});

test("Claude fixture resumes from an atomic cursor and remains idempotent", () => {
  const parsed = parseSyntheticBundle(fixture("claude"));
  const first = advanceSyntheticImport(parsed, undefined, 1);
  assert.equal(first.next_message, 1);
  const complete = advanceSyntheticImport(parsed, JSON.parse(JSON.stringify(first)), 1);
  assert.deepEqual(complete, advanceSyntheticImport(parsed));
  assert.deepEqual(advanceSyntheticImport(parsed, complete), complete);
  assert.deepEqual(complete.records.map(item => item.provenance),
    ["owner_statement", "assistant_generated", "quoted_third_party"]);
});

test("changed bundle and damaged checkpoint fail closed without skipping messages", () => {
  const parsed = parseSyntheticBundle(fixture("chatgpt"));
  const first = advanceSyntheticImport(parsed, undefined, 1);
  const changed = fixture("chatgpt");
  changed.conversations[0].mapping.a.message.content.parts[0] += " changed";
  assert.throws(() => advanceSyntheticImport(parseSyntheticBundle(changed), first), /checkpoint mismatch/);
  const damaged = structuredClone(first);
  damaged.records.pop();
  assert.throws(() => advanceSyntheticImport(parsed, damaged), /checkpoint records do not match cursor/);
});

test("present but falsy or non-object checkpoints never start a fresh import", () => {
  const parsed = parseSyntheticBundle(fixture("chatgpt"));
  for (const invalid of [null, false, 0, "", []]) {
    assert.throws(() => advanceSyntheticImport(parsed, invalid), /invalid checkpoint object/);
  }
  assert.equal(advanceSyntheticImport(parsed, undefined, 1).next_message, 1);
});

test("stable ID order uses UTF-16 code units across conversations and messages", () => {
  const base = fixture("claude");
  const template = structuredClone(base.conversations[0].chat_messages[0]);
  const makeMessage = id => ({ ...structuredClone(template), id });
  base.conversations = [
    { id: "a", chat_messages: [makeMessage("z")] },
    { id: "A", chat_messages: [makeMessage("z"), makeMessage("-a"), makeMessage("Z")] },
    { id: "!", chat_messages: [makeMessage("a")] },
  ];
  const parsed = parseSyntheticBundle(base);
  assert.deepEqual(parsed.messages.map(message => [message.conversation_id, message.message_id]),
    [["!", "a"], ["A", "-a"], ["A", "Z"], ["A", "z"], ["a", "z"]]);
  const first = advanceSyntheticImport(parsed, undefined, 2);
  assert.deepEqual(advanceSyntheticImport(parsed, first), advanceSyntheticImport(parsed));
});

test("unknown shapes, duplicate IDs, and oversize input fail closed", () => {
  const base = fixture("chatgpt");
  assert.throws(() => parseSyntheticBundle({ ...base, synthetic_fixture: false }), /unsupported or non-synthetic/);
  const unsupported = structuredClone(base);
  unsupported.conversations[0].mapping.a.message.content = { content_type: "image", parts: [] };
  assert.throws(() => parseSyntheticBundle(unsupported), /unsupported ChatGPT content shape/);
  const duplicate = structuredClone(base);
  duplicate.conversations[0].mapping.b.message.id = "m-01";
  assert.throws(() => parseSyntheticBundle(duplicate), /duplicate message id/);
  const duplicateConversation = structuredClone(base);
  duplicateConversation.conversations.push(structuredClone(duplicateConversation.conversations[0]));
  assert.throws(() => parseSyntheticBundle(duplicateConversation), /duplicate conversation id/);
  const missingNode = structuredClone(base);
  missingNode.conversations[0].mapping.c = {};
  assert.throws(() => parseSyntheticBundle(missingNode), /malformed ChatGPT mapping node/);
  const nullNode = structuredClone(base);
  nullNode.conversations[0].mapping.c = { message: null, parent: "a" };
  assert.throws(() => parseSyntheticBundle(nullNode), /unexpected null ChatGPT message/);
  const supportedRoot = structuredClone(base);
  supportedRoot.conversations[0].mapping.root = { message: null, parent: null };
  assert.equal(parseSyntheticBundle(supportedRoot).messages.length, 2);
  const oversized = structuredClone(base);
  oversized.conversations[0].mapping.a.message.content.parts[0] = "x".repeat(8193);
  assert.throws(() => parseSyntheticBundle(oversized), /message text exceeds/);
});

test("checkpoint directory rejects public directories and symlinks", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-dir-test-"));
  try {
    const privateDir = path.join(parent, "private");
    await ensurePrivateCheckpointDirectory(privateDir);
    const publicDir = path.join(parent, "public");
    mkdirSync(publicDir, { mode: 0o755 });
    chmodSync(publicDir, 0o755);
    await assert.rejects(ensurePrivateCheckpointDirectory(publicDir), /not private/);
    const link = path.join(parent, "link");
    symlinkSync(privateDir, link);
    await assert.rejects(ensurePrivateCheckpointDirectory(link), /not private/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("malformed CLI checkpoint is preserved and never replaced by a fresh state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-cli-test-"));
  const priorArgv = process.argv;
  const priorTmp = process.env.TMPDIR;
  const priorExitCode = process.exitCode;
  const priorError = console.error;
  try {
    process.env.TMPDIR = root;
    process.argv = [process.execPath, "run.mjs", "chatgpt"];
    const stateDir = path.join(root, "lumi-humanwiki-synthetic-lab");
    mkdirSync(stateDir, { mode: 0o700 });
    const statePath = path.join(stateDir, "chatgpt.checkpoint.json");
    const errors = [];
    console.error = message => errors.push(message);
    for (const [index, invalid] of ["null", "false", "0", '""'].entries()) {
      writeFileSync(statePath, invalid);
      process.exitCode = undefined;
      await import(`../scripts/humanwiki-synthetic/run.mjs?malformed=${index}`);
      assert.equal(process.exitCode, 1);
      assert.equal(readFileSync(statePath, "utf8"), invalid);
      assert.deepEqual(readdirSync(stateDir), ["chatgpt.checkpoint.json"]);
    }
    assert.ok(errors.every(message => /invalid checkpoint object/.test(message)));
  } finally {
    process.argv = priorArgv;
    if (priorTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmp;
    process.exitCode = priorExitCode;
    console.error = priorError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed checkpoint write or rename removes only its owned temporary file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-write-test-"));
  try {
    await assert.rejects(writeCheckpointAtomic(root, path.join(root, "bad.json"), { invalid: 1n }),
      /BigInt/);
    assert.deepEqual(readdirSync(root), []);
    const target = path.join(root, "checkpoint.json");
    mkdirSync(target);
    await assert.rejects(writeCheckpointAtomic(root, target, { schema: 2 }), /EISDIR|ENOTEMPTY/);
    assert.deepEqual(readdirSync(root), ["checkpoint.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
