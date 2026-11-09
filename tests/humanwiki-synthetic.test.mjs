import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseSyntheticBundle, advanceSyntheticImport } from "../scripts/humanwiki-synthetic/ingest.mjs";
import { inspectSyntheticImport } from "../scripts/humanwiki-synthetic/inspect.mjs";
import { previewSyntheticOverlaps } from "../scripts/humanwiki-synthetic/overlap.mjs";
import { previewSyntheticReviewQueue } from "../scripts/humanwiki-synthetic/review-preview.mjs";
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


test("timestamp validation rejects zone-less, impossible and invalid-offset times", () => {
  for (const provider of ["chatgpt", "claude"]) {
    for (const invalid of [
      "2026-01-01T10:00:00", "2026-02-31T10:00:00Z", "2025-02-29T10:00:00Z",
      "2026-13-01T10:00:00Z", "2026-01-01T24:00:00Z",
      "2026-01-01T10:00:60Z", "2026-01-01T10:00:00+14:30",
      "2026-01-01T10:00:00+01:60", "2026-01-01T10:00:00Z\n",
    ]) {
      const bundle = fixture(provider);
      const message = provider === "chatgpt" ?
        bundle.conversations[0].mapping.a.message : bundle.conversations[0].chat_messages[0];
      if (provider === "chatgpt") message.create_time = invalid;
      else message.created_at = invalid;
      assert.throws(() => parseSyntheticBundle(bundle), /invalid message time/, invalid);
    }
  }
});

test("timestamp validation normalizes valid zoned times and leap days to UTC", () => {
  for (const provider of ["chatgpt", "claude"]) {
    for (const [timestamp, expected] of [
      ["2024-02-29T12:34:56.123456789+03:30", "2024-02-29T09:04:56.123Z"],
      ["2026-01-01T10:00:00+01:00", "2026-01-01T09:00:00.000Z"],
      ["2026-01-01T00:30:00-03:30", "2026-01-01T04:00:00.000Z"],
      ["2026-01-01T10:00:00Z", "2026-01-01T10:00:00.000Z"],
    ]) {
      const bundle = fixture(provider);
      const message = provider === "chatgpt" ?
        bundle.conversations[0].mapping.a.message : bundle.conversations[0].chat_messages[0];
      if (provider === "chatgpt") message.create_time = timestamp;
      else message.created_at = timestamp;
      const parsed = parseSyntheticBundle(bundle);
      const staged = advanceSyntheticImport(parsed, undefined, 1);
      assert.equal(parsed.messages[0].observed_at, expected, timestamp);
      assert.equal(staged.records[0].observed_at, expected, timestamp);
      assert.deepEqual(advanceSyntheticImport(parsed, staged), advanceSyntheticImport(parsed));
    }
  }
});

test("synthetic inspection inventories provenance but exposes no source text or claims", () => {
  for (const provider of ["chatgpt", "claude"]) {
    const parsed = parseSyntheticBundle(fixture(provider));
    const report = inspectSyntheticImport(parsed);
    assert.equal(report.synthetic_fixture_only, true);
    assert.equal(report.messages_total, 2);
    assert.equal(report.segments_total, 3);
    assert.equal(report.messages_staged, 0);
    assert.equal(report.messages_remaining, 2);
    assert.equal(report.segments_staged, 0);
    assert.equal(report.segments_remaining, 3);
    assert.deepEqual(report.provenance_segments, {
      owner_statement: 1, assistant_generated: 1, quoted_third_party: 1, unknown: 0,
    });
    assert.equal(report.sensitivity, "unclassified");
    assert.equal(report.review, "proposed");
    assert.equal(report.claims_created, 0);
    assert.equal(report.real_import_enabled, false);
    assert.equal(report.bundle_sha256, parsed.digest);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes("garden"));
    assert.ok(!serialized.includes("spaceship"));
    assert.ok(!serialized.includes("gate is open"));
    assert.ok(!serialized.includes("text"));
    assert.deepEqual(inspectSyntheticImport(parsed), report);
  }
});

test("synthetic inspection handles resumed checkpoints and rejects damaged replay", () => {
  const parsed = parseSyntheticBundle(fixture("chatgpt"));
  const first = advanceSyntheticImport(parsed, undefined, 1);
  const snapshot = JSON.stringify(first);
  const report = inspectSyntheticImport(parsed, first);
  assert.equal(report.messages_staged, 1);
  assert.equal(report.segments_staged, 2);
  assert.equal(report.messages_remaining, 1);
  assert.equal(report.segments_remaining, 1);
  assert.equal(JSON.stringify(first), snapshot, "inspection must not mutate state");
  const completed = advanceSyntheticImport(parsed, first);
  const final = inspectSyntheticImport(parsed, completed);
  assert.equal(final.messages_remaining, 0);
  assert.equal(final.segments_remaining, 0);
  const damaged = structuredClone(first);
  damaged.records[0].text = "tampered";
  assert.throws(() => inspectSyntheticImport(parsed, damaged), /checkpoint records do not match cursor/);
  const wrongFixture = parseSyntheticBundle(fixture("claude"));
  assert.throws(() => inspectSyntheticImport(wrongFixture, first), /checkpoint mismatch/);
});

test("synthetic inspection rejects unknown provenance and malformed arguments", () => {
  const parsed = parseSyntheticBundle(fixture("chatgpt"));
  const changed = structuredClone(parsed);
  changed.messages[0].segments[0].provenance = "owner_confirmed";
  assert.throws(() => inspectSyntheticImport(changed), /unknown segment provenance/);
  assert.throws(() => inspectSyntheticImport(null), /invalid parsed synthetic bundle/);
  assert.throws(() => inspectSyntheticImport({ messages: [], format: "unknown" }), /invalid parsed synthetic bundle/);
  assert.throws(() => inspectSyntheticImport(parsed, 0), /invalid checkpoint object/);
});

test("inspection CLI is fixture-only, does not persist data and is host-timezone stable", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/inspect-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-inspection-"));
  const invoke = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const utc = invoke(["chatgpt"], "UTC");
    const prague = invoke(["chatgpt"], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(prague.status, 0, prague.stderr);
    assert.equal(utc.stdout, prague.stdout);
    const report = JSON.parse(utc.stdout);
    assert.equal(report.messages_total, 2);
    assert.equal(report.claims_created, 0);
    assert.ok(!utc.stdout.includes("fictional garden"));
    for (const args of [[], ["../../private-export.json"], ["chatgpt", "extra"]]) {
      const denied = invoke(args, "UTC");
      assert.equal(denied.status, 2);
      assert.equal(denied.stdout, "");
    }
    assert.deepEqual(readdirSync(root), [], "inspection must not create checkpoint files");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("synthetic overlap preview is deterministic and creates no claims", () => {
  const chatgpt = fixture("chatgpt");
  const claude = fixture("claude");
  const preview = previewSyntheticOverlaps([chatgpt, claude]);
  assert.equal(preview.synthetic_fixture_only, true);
  assert.deepEqual(preview.sources.map(source => source.source_id),
    ["fixture-chatgpt-01", "fixture-claude-01"]);
  assert.equal(preview.segments_total, 6);
  assert.equal(preview.duplicate_groups, 0);
  assert.equal(preview.cross_source_duplicate_groups, 0);
  assert.equal(preview.repeated_segment_occurrences, 0);
  assert.deepEqual(preview.groups, []);
  assert.equal(preview.claims_created, 0);
  assert.equal(preview.real_import_enabled, false);
  assert.deepEqual(previewSyntheticOverlaps([claude, chatgpt]), preview);
});

test("synthetic repeated source text never merges quote or assistant provenance", () => {
  const chatgpt = fixture("chatgpt");
  const claude = fixture("claude");
  claude.conversations[0].chat_messages[0].content[0].text =
    "I am planning a fictional garden.\nAda said the blue gate is open.";
  claude.conversations[0].chat_messages[1].content[0].text =
    "The user owns a silver spaceship.";
  const preview = previewSyntheticOverlaps([chatgpt, claude]);
  assert.equal(preview.duplicate_groups, 3);
  assert.equal(preview.cross_source_duplicate_groups, 3);
  assert.equal(preview.repeated_segment_occurrences, 6);
  assert.ok(preview.groups.every(group =>
    group.members.length === 2 && group.cross_source === true &&
    group.independent_evidence === false && group.review === "proposed"));
  const quote = preview.groups.find(group =>
    group.members.some(member => member.provenance === "quoted_third_party"));
  assert.ok(quote);
  assert.deepEqual(quote.members.map(member => member.provenance),
    ["quoted_third_party", "owner_statement"]);
  assert.deepEqual(quote.members.map(member => member.speaker),
    ["unknown", "user"]);
  assert.deepEqual(quote.members.map(member => member.enclosing_message_speaker),
    ["user", "user"]);
  const assistant = preview.groups.find(group =>
    group.members.some(member => member.provenance === "assistant_generated"));
  assert.ok(assistant);
  assert.ok(assistant.members.every(member =>
    member.provenance === "assistant_generated"));
  assert.ok(preview.groups.every(group => group.members.every(member =>
    member.review === "proposed" && member.sensitivity === "unclassified" &&
    member.locator.source_id && Number.isInteger(member.locator.segment))));
  const serialized = JSON.stringify(preview);
  for (const text of ["garden.", "blue gate is open", "silver spaceship",
    "content_sha256", "owner_private_unassigned"]) {
    assert.ok(!serialized.includes(text), text);
  }
  assert.deepEqual(previewSyntheticOverlaps([claude, chatgpt]), preview);
});

test("synthetic repeated text within one source is not cross-source evidence", () => {
  const chatgpt = fixture("chatgpt");
  chatgpt.conversations[0].mapping.a.message.content.parts[0] = "echo\necho";
  const preview = previewSyntheticOverlaps([chatgpt, fixture("claude")]);
  assert.equal(preview.duplicate_groups, 1);
  assert.equal(preview.cross_source_duplicate_groups, 0);
  const group = preview.groups[0];
  assert.equal(group.cross_source, false);
  assert.equal(group.independent_evidence, false);
  assert.equal(group.members.length, 2);
  assert.deepEqual(group.members.map(member => member.locator.segment), [0, 1]);
  const differentCase = fixture("claude");
  differentCase.conversations[0].chat_messages[0].content[0].text = "Echo";
  assert.equal(previewSyntheticOverlaps([chatgpt, differentCase]).cross_source_duplicate_groups, 0);
});

test("synthetic overlap preview rejects duplicate source identities and non-fixtures", () => {
  const a = fixture("chatgpt");
  const b = fixture("claude");
  assert.throws(() => previewSyntheticOverlaps([]), /exactly two synthetic bundles/);
  assert.throws(() => previewSyntheticOverlaps([a]), /exactly two synthetic bundles/);
  assert.throws(() => previewSyntheticOverlaps([a, { ...b, source_id: a.source_id }]),
    /duplicate source identity/);
  assert.throws(() => previewSyntheticOverlaps([a, { ...b, synthetic_fixture: false }]),
    /unsupported or non-synthetic bundle/);
  const invalidTime = structuredClone(b);
  invalidTime.conversations[0].chat_messages[0].created_at = "2026-02-31T10:00:00Z";
  assert.throws(() => previewSyntheticOverlaps([a, invalidTime]), /invalid message time/);
});

test("synthetic overlap CLI reads only fixed fixtures and never writes checkpoints", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/overlap-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-overlap-"));
  const run = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const utc = run([], "UTC");
    const prague = run([], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(prague.status, 0, prague.stderr);
    assert.equal(utc.stdout, prague.stdout);
    const report = JSON.parse(utc.stdout);
    assert.equal(report.duplicate_groups, 0);
    assert.equal(report.claims_created, 0);
    assert.ok(!utc.stdout.includes("fictional garden"));
    const rejected = run(["../../private-export.json"], "UTC");
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout, "");
    assert.deepEqual(readdirSync(root), [], "overlap CLI must not write files");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review queue keeps every fictional source segment proposed and unclassified", () => {
  const chatgpt = fixture("chatgpt");
  const claude = fixture("claude");
  const queue = previewSyntheticReviewQueue([chatgpt, claude]);
  assert.equal(queue.synthetic_fixture_only, true);
  assert.equal(queue.segments_total, 6);
  assert.equal(queue.entries.length, 6);
  assert.equal(queue.duplicate_groups, 0);
  assert.deepEqual(queue.provenance_counts, {
    owner_statement: 2, assistant_generated: 2, quoted_third_party: 2, unknown: 0,
  });
  assert.deepEqual(queue.sources.map(source => source.source_id),
    ["fixture-chatgpt-01", "fixture-claude-01"]);
  const locators = queue.entries.map(entry => JSON.stringify(entry.locator));
  assert.equal(new Set(locators).size, 6);
  assert.ok(queue.entries.every(entry =>
    entry.review === "proposed" && entry.freshness === "current" &&
    entry.disputed === false && entry.sensitivity === "unclassified" &&
    entry.scope === "owner_private_unassigned" &&
    entry.requires_explicit_review === true &&
    entry.eligible_for_automatic_confirmation === false &&
    entry.independent_evidence === false && entry.duplicate_group_id === null &&
    entry.reason_codes.length === 1));
  assert.equal(queue.claims_created, 0);
  assert.equal(queue.review_outcomes_written, 0);
  assert.equal(queue.real_import_enabled, false);
  const serialized = JSON.stringify(queue);
  for (const forbidden of ["fictional garden", "silver spaceship", "blue gate is open",
    "content_sha256", "text\":", "claim_id"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  assert.deepEqual(previewSyntheticReviewQueue([claude, chatgpt]), queue);
});

test("review queue never promotes quoted or assistant material on exact text overlap", () => {
  const chatgpt = fixture("chatgpt");
  const claude = fixture("claude");
  claude.conversations[0].chat_messages[0].content[0].text =
    "I am planning a fictional garden.\nAda said the blue gate is open.";
  claude.conversations[0].chat_messages[1].content[0].text =
    "The user owns a silver spaceship.";
  const queue = previewSyntheticReviewQueue([chatgpt, claude]);
  assert.equal(queue.segments_total, 6);
  assert.equal(queue.duplicate_groups, 3);
  assert.ok(queue.entries.every(entry =>
    entry.duplicate_group_id !== null &&
    entry.cross_source_repeat === true &&
    entry.reason_codes.includes("repeated_text_not_independent_evidence") &&
    entry.independent_evidence === false && entry.eligible_for_automatic_confirmation === false));
  const quoted = queue.entries.find(entry => entry.provenance === "quoted_third_party");
  assert.ok(quoted);
  assert.equal(quoted.speaker, "unknown");
  assert.equal(quoted.enclosing_message_speaker, "user");
  assert.ok(quoted.reason_codes.includes("quoted_third_party_unverified"));
  const assistant = queue.entries.filter(entry => entry.provenance === "assistant_generated");
  assert.equal(assistant.length, 2);
  assert.ok(assistant.every(entry =>
    entry.reason_codes.includes("assistant_output_not_owner_evidence")));
  assert.ok(queue.entries.some(entry =>
    entry.provenance === "owner_statement" &&
    entry.reason_codes.includes("owner_statement_unverified")));
  assert.deepEqual(previewSyntheticReviewQueue([claude, chatgpt]), queue);
});

test("same-source repeated lines remain separate unverified review entries", () => {
  const chatgpt = fixture("chatgpt");
  chatgpt.conversations[0].mapping.a.message.content.parts[0] = "echo\necho";
  const queue = previewSyntheticReviewQueue([chatgpt, fixture("claude")]);
  const repeated = queue.entries.filter(entry => entry.duplicate_group_id !== null);
  assert.equal(repeated.length, 2);
  assert.ok(repeated.every(entry =>
    entry.cross_source_repeat === false && entry.independent_evidence === false));
  assert.deepEqual(repeated.map(entry => entry.locator.segment), [0, 1]);
  assert.equal(queue.claims_created, 0);
});

test("synthetic review triage rejects malformed sources and never mutates input", () => {
  const a = fixture("chatgpt");
  const b = fixture("claude");
  const snapshot = JSON.stringify([a, b]);
  previewSyntheticReviewQueue([a, b]);
  assert.equal(JSON.stringify([a, b]), snapshot);
  assert.throws(() => previewSyntheticReviewQueue([]), /exactly two synthetic bundles/);
  assert.throws(() => previewSyntheticReviewQueue([a, { ...b, source_id: a.source_id }]),
    /duplicate source identity/);
  assert.throws(() => previewSyntheticReviewQueue([a, { ...b, synthetic_fixture: false }]),
    /unsupported or non-synthetic bundle/);
  const invalid = structuredClone(b);
  invalid.conversations[0].chat_messages[0].created_at = "2026-02-31T10:00:00Z";
  assert.throws(() => previewSyntheticReviewQueue([a, invalid]), /invalid message time/);
});

test("fixture review preview CLI is read-only, deterministic and denies file arguments", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/review-preview-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-review-"));
  const invoke = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const utc = invoke([], "UTC");
    const prague = invoke([], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(prague.status, 0, prague.stderr);
    assert.equal(utc.stdout, prague.stdout);
    const report = JSON.parse(utc.stdout);
    assert.equal(report.entries.length, 6);
    assert.equal(report.claims_created, 0);
    assert.ok(!utc.stdout.includes("fictional garden"));
    const rejected = invoke(["../../private-export.json"], "UTC");
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout, "");
    assert.deepEqual(readdirSync(root), [], "review preview CLI must not write checkpoints");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
