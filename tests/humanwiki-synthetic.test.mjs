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
import { rehearseSyntheticTriage } from "../scripts/humanwiki-synthetic/triage-rehearsal.mjs";
import { bindSyntheticTriageIntents, rehearseVersionBoundSyntheticTriage } from "../scripts/humanwiki-synthetic/version-bound-triage.mjs";
import { previewSyntheticSourceLifecycle } from "../scripts/humanwiki-synthetic/lifecycle-preview.mjs";
import { makeSyntheticRestoreFixture, previewSyntheticRestorePreflight } from "../scripts/humanwiki-synthetic/restore-preflight.mjs";
import { previewSyntheticRestoreReplayPlan } from "../scripts/humanwiki-synthetic/restore-replay-plan.mjs";
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

test("triage rehearsal defaults to pending and never confirms fictional content", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const report = rehearseSyntheticTriage(bundles);
  assert.equal(report.synthetic_fixture_only, true);
  assert.equal(report.workflow, "fictional_source_segment_triage_rehearsal");
  assert.deepEqual(report.disposition_counts,
    { pending: 6, consider: 0, skip: 0, defer: 0 });
  assert.equal(report.triage_intents_applied, 0);
  assert.deepEqual(report.rehearsal_events, []);
  assert.ok(report.entries.every(entry =>
    entry.triage_disposition === "pending" &&
    entry.review === "proposed" && entry.sensitivity === "unclassified" &&
    entry.eligible_for_automatic_confirmation === false));
  assert.equal(report.claims_created, 0);
  assert.equal(report.review_outcomes_written, 0);
  assert.equal(report.real_import_enabled, false);
  assert.deepEqual(rehearseSyntheticTriage([...bundles].reverse()), report);
});

test("explicit fictional triage intents affect only their own source locator", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const queue = previewSyntheticReviewQueue(bundles);
  const owner = queue.entries.find(entry => entry.provenance === "owner_statement");
  const assistant = queue.entries.find(entry => entry.provenance === "assistant_generated");
  const quote = queue.entries.find(entry => entry.provenance === "quoted_third_party");
  const intents = [
    { locator: owner.locator, choice: "consider" },
    { locator: assistant.locator, choice: "skip" },
    { locator: quote.locator, choice: "defer" },
  ];
  const snapshot = JSON.stringify({ bundles, intents });
  const report = rehearseSyntheticTriage(bundles, intents);
  assert.deepEqual(report.disposition_counts,
    { pending: 3, consider: 1, skip: 1, defer: 1 });
  assert.deepEqual(report.rehearsal_events.map(event => [event.step, event.intent]),
    [[1, "consider"], [2, "skip"], [3, "defer"]]);
  assert.ok(report.rehearsal_events.every(event =>
    event.kind === "synthetic_rehearsal_only"));
  for (const [source, expected] of [
    [owner, "consider"], [assistant, "skip"], [quote, "defer"],
  ]) {
    const entry = report.entries.find(item =>
      JSON.stringify(item.locator) === JSON.stringify(source.locator));
    assert.equal(entry.triage_disposition, expected);
    assert.equal(entry.provenance, source.provenance);
    assert.equal(entry.review, "proposed");
    assert.equal(entry.sensitivity, "unclassified");
    assert.equal(entry.independent_evidence, false);
    assert.equal(entry.eligible_for_automatic_confirmation, false);
  }
  assert.equal(report.claims_created, 0);
  assert.equal(report.review_outcomes_written, 0);
  assert.equal(JSON.stringify({ bundles, intents }), snapshot);
  assert.deepEqual(rehearseSyntheticTriage(bundles, intents), report);
});

test("triage choices do not propagate across repeated text or speakers", () => {
  const chatgpt = fixture("chatgpt");
  const claude = fixture("claude");
  claude.conversations[0].chat_messages[0].content[0].text =
    "I am planning a fictional garden.\nAda said the blue gate is open.";
  const bundles = [chatgpt, claude];
  const queue = previewSyntheticReviewQueue(bundles);
  const quoted = queue.entries.find(entry => entry.provenance === "quoted_third_party");
  const associated = queue.entries.find(entry =>
    entry.duplicate_group_id === quoted.duplicate_group_id &&
    JSON.stringify(entry.locator) !== JSON.stringify(quoted.locator));
  assert.ok(associated);
  assert.equal(associated.provenance, "owner_statement");
  const report = rehearseSyntheticTriage(bundles, [
    { locator: quoted.locator, choice: "skip" },
  ]);
  const matching = report.entries.filter(entry =>
    entry.duplicate_group_id === quoted.duplicate_group_id);
  assert.equal(matching.length, 2);
  assert.deepEqual(matching.map(entry => [entry.provenance, entry.triage_disposition]),
    [["quoted_third_party", "skip"], ["owner_statement", "pending"]]);
  assert.ok(matching.every(entry =>
    entry.independent_evidence === false &&
    entry.review === "proposed" && entry.cross_source_repeat === true));
});

test("triage rehearsal fails closed on duplicate unknown and malformed decisions", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const locator = previewSyntheticReviewQueue(bundles).entries[0].locator;
  const valid = { locator, choice: "consider" };
  for (const invalid of [
    null, false, [], "consider", { locator },
    { locator, choice: "confirm" },
    { locator, choice: "consider", comment: "untrusted text" },
    { locator: { ...locator, segment: "0" }, choice: "consider" },
    { locator: { ...locator, segment: -1 }, choice: "consider" },
    { locator: { ...locator, message_id: "not-present" }, choice: "consider" },
    { locator: { ...locator, secret: "x" }, choice: "consider" },
  ]) {
    assert.throws(() => rehearseSyntheticTriage(bundles, [invalid]),
      /Synthetic triage:/);
  }
  for (const intents of [null, 0, {}, "consider", [valid, valid]]) {
    assert.throws(() => rehearseSyntheticTriage(bundles, intents),
      /Synthetic triage:/);
  }
  assert.throws(() => rehearseSyntheticTriage(
    [bundles[0], { ...bundles[1], synthetic_fixture: false }], [valid]),
    /unsupported or non-synthetic/);
  assert.throws(() => rehearseSyntheticTriage(
    bundles, Array.from({ length: 7 }, () => valid)),
    /invalid intent list/);
});

test("triage rehearsal CLI is read-only, fixture-only and timezone-stable", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/triage-rehearsal-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-triage-"));
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
    assert.equal(report.disposition_counts.pending, 6);
    assert.equal(report.triage_intents_applied, 0);
    assert.equal(report.claims_created, 0);
    assert.equal(report.review_outcomes_written, 0);
    for (const content of ["fictional garden", "silver spaceship", "blue gate is open", "content_sha256"]) {
      assert.ok(!utc.stdout.includes(content), content);
    }
    const denied = invoke(["../../private-export.json"], "UTC");
    assert.equal(denied.status, 2);
    assert.equal(denied.stdout, "");
    assert.deepEqual(readdirSync(root), [], "no checkpoint or source file may be written");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("versioned toy triage captures source digests for exact selected locators", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const queue = previewSyntheticReviewQueue(bundles);
  const chat = queue.entries.find(entry => entry.locator.source_id === "fixture-chatgpt-01");
  const claude = queue.entries.find(entry => entry.locator.source_id === "fixture-claude-01");
  const selections = [
    { locator: chat.locator, choice: "consider" },
    { locator: claude.locator, choice: "defer" },
  ];
  const snapshot = JSON.stringify({ bundles, selections });
  const bound = bindSyntheticTriageIntents(bundles, selections);
  assert.equal(bound.length, 2);
  for (let i = 0; i < bound.length; i++) {
    assert.deepEqual(bound[i].locator, selections[i].locator);
    assert.equal(bound[i].choice, selections[i].choice);
    assert.match(bound[i].bundle_digest, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(bound[0].bundle_digest, bound[1].bundle_digest);
  assert.deepEqual(bindSyntheticTriageIntents([...bundles].reverse(), selections), bound);
  assert.equal(JSON.stringify({ bundles, selections }), snapshot);
});

test("version-bound synthetic triage accepts current source versions without approving claims", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const locators = previewSyntheticReviewQueue(bundles).entries.map(e => e.locator);
  const intents = bindSyntheticTriageIntents(bundles, [
    { locator: locators[0], choice: "consider" },
    { locator: locators[2], choice: "skip" },
  ]);
  const snapshot = JSON.stringify({ bundles, intents });
  const report = rehearseVersionBoundSyntheticTriage(bundles, intents);
  assert.equal(report.source_version_binding, "toy_bundle_sha256_only");
  assert.equal(report.source_version_checks, 2);
  assert.deepEqual(report.disposition_counts,
    { pending: 4, consider: 1, skip: 1, defer: 0 });
  assert.equal(report.claims_created, 0);
  assert.equal(report.review_outcomes_written, 0);
  assert.equal(report.real_import_enabled, false);
  assert.ok(report.entries.every(entry =>
    entry.review === "proposed" && entry.sensitivity === "unclassified" &&
    entry.independent_evidence === false && entry.eligible_for_automatic_confirmation === false));
  assert.ok(!JSON.stringify(report).includes("bundle_digest"),
    "source content fingerprints must not leak into the report");
  assert.equal(JSON.stringify({ bundles, intents }), snapshot);
  assert.deepEqual(rehearseVersionBoundSyntheticTriage([...bundles].reverse(), intents), report);
  const zero = rehearseVersionBoundSyntheticTriage(bundles);
  assert.equal(zero.source_version_checks, 0);
  assert.equal(zero.disposition_counts.pending, 6);
});

test("version-bound synthetic intent rejects changed text under identical locator", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const selected = previewSyntheticReviewQueue(bundles).entries.find(e =>
    e.locator.source_id === "fixture-chatgpt-01");
  const intents = bindSyntheticTriageIntents(bundles, [
    { locator: selected.locator, choice: "consider" },
  ]);
  const changed = structuredClone(bundles);
  changed[0].conversations[0].mapping.a.message.content.parts[0] += " (edited)";
  assert.equal(changed[0].conversations[0].mapping.a.message.id, selected.locator.message_id);
  assert.throws(() => rehearseVersionBoundSyntheticTriage(changed, intents),
    /stale or missing synthetic source version/);
  assert.equal(rehearseVersionBoundSyntheticTriage(bundles, intents).source_version_checks, 1);
});

test("source-wide binding invalidates on speaker time or unrelated-message edits", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const selected = previewSyntheticReviewQueue(bundles).entries.find(e =>
    e.locator.source_id === "fixture-chatgpt-01");
  const intents = bindSyntheticTriageIntents(bundles, [
    { locator: selected.locator, choice: "defer" },
  ]);
  for (const mutate of [
    bundle => { bundle.conversations[0].mapping.a.message.author.role = "assistant"; },
    bundle => { bundle.conversations[0].mapping.a.message.create_time = "2026-01-01T10:00:01Z"; },
    bundle => { bundle.conversations[0].mapping.b.message.content.parts[0] += " changed"; },
  ]) {
    const changed = structuredClone(bundles);
    mutate(changed[0]);
    assert.throws(() => rehearseVersionBoundSyntheticTriage(changed, intents),
      /stale or missing synthetic source version/);
  }
  const otherChanged = structuredClone(bundles);
  otherChanged[1].conversations[0].chat_messages[0].content[0].text += " changed";
  assert.equal(rehearseVersionBoundSyntheticTriage(otherChanged, intents).source_version_checks, 1,
    "unrelated source changes do not invalidate this source-bound decision");
});

test("missing forged duplicate or unbound decisions fail closed", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const locator = previewSyntheticReviewQueue(bundles).entries[0].locator;
  const [valid] = bindSyntheticTriageIntents(bundles, [
    { locator, choice: "consider" },
  ]);
  for (const invalid of [
    { locator, choice: "consider" },
    { ...valid, bundle_digest: undefined },
    { ...valid, bundle_digest: "0".repeat(64) },
    { ...valid, bundle_digest: valid.bundle_digest.toUpperCase() },
    { ...valid, extra: "not allowed" },
    { ...valid, choice: "confirm" },
    { ...valid, locator: { ...locator, message_id: "missing" } },
    { ...valid, locator: { ...locator, secret: "extra" } },
    null,
    false,
  ]) {
    assert.throws(() => rehearseVersionBoundSyntheticTriage(bundles, [invalid]));
  }
  assert.throws(() => rehearseVersionBoundSyntheticTriage(bundles, [valid, valid]),
    /duplicate triage locator/);
  for (const invalid of [null, 0, {}, "x"]) {
    assert.throws(() => rehearseVersionBoundSyntheticTriage(bundles, invalid),
      /invalid bound intent list/);
  }
  assert.throws(() => bindSyntheticTriageIntents(bundles, [
    { locator, choice: "confirm" },
  ]), /invalid triage intent/);
  const wrongSource = [bundles[0], { ...bundles[1], source_id: bundles[0].source_id }];
  assert.throws(() => rehearseVersionBoundSyntheticTriage(wrongSource, [valid]),
    /duplicate source identity/);
});

test("version-bound CLI proves stale decisions fail without writes or personal data", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/version-bound-triage-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-version-bound-"));
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
    assert.equal(report.synthetic_fixture_only, true);
    assert.equal(report.stale_intent_rejected, true);
    assert.equal(report.bound_intents_checked, 1);
    assert.equal(report.claims_created, 0);
    assert.equal(report.review_outcomes_written, 0);
    assert.equal(report.real_import_enabled, false);
    for (const text of ["fictional garden", "silver spaceship", "blue gate is open", "bundle_digest"]) {
      assert.ok(!utc.stdout.includes(text), text);
    }
    const denied = invoke(["../../private-export.json"], "UTC");
    assert.equal(denied.status, 2);
    assert.equal(denied.stdout, "");
    assert.deepEqual(readdirSync(root), [], "CLI must not write any fixture checkpoint");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("synthetic lifecycle baseline preserves only proposed source-segment metadata", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const preview = previewSyntheticSourceLifecycle(bundles);
  assert.equal(preview.synthetic_fixture_only, true);
  assert.equal(preview.mode, "hypothetical_source_lifecycle_policy_only");
  assert.equal(preview.scenarios_applied, 0);
  assert.equal(preview.segments_total, 6);
  assert.equal(preview.visible_segments, 6);
  assert.equal(preview.suppressed_segments, 0);
  assert.equal(preview.visible_entries.length, 6);
  assert.ok(preview.source_states.every(source =>
    source.action === "active" && source.would_allow_new_source_reads &&
    source.would_allow_pending_review && !source.would_invalidate_source_derivatives &&
    !source.operation_completed));
  assert.ok(preview.visible_entries.every(entry =>
    entry.review === "proposed" && entry.sensitivity === "unclassified" &&
    !entry.eligible_for_automatic_confirmation && !entry.independent_evidence));
  assert.equal(preview.claims_created, 0);
  assert.equal(preview.review_outcomes_written, 0);
  assert.equal(preview.actual_source_reads_performed, 0);
  assert.equal(preview.durable_lifecycle_events_written, 0);
  assert.equal(preview.tombstones_written, 0);
  assert.equal(preview.real_import_enabled, false);
  const serialized = JSON.stringify(preview);
  for (const text of ["fictional garden", "silver spaceship", "blue gate is open",
    "content_sha256", "bundle_digest"]) {
    assert.ok(!serialized.includes(text), text);
  }
  assert.deepEqual(previewSyntheticSourceLifecycle([...bundles].reverse()), preview);
});

test("pause stops hypothetical new reads while preserving existing review visibility", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const preview = previewSyntheticSourceLifecycle(bundles, [
    { source_id: "fixture-chatgpt-01", action: "pause_sync" },
  ]);
  const paused = preview.source_states.find(s => s.source_id === "fixture-chatgpt-01");
  assert.equal(paused.action, "pause_sync");
  assert.equal(paused.would_allow_new_source_reads, false);
  assert.equal(paused.would_allow_pending_review, true);
  assert.equal(paused.would_invalidate_source_derivatives, false);
  assert.equal(paused.retention_recheck_required, false);
  assert.equal(paused.independent_witness_required, false);
  assert.equal(paused.operation_completed, false);
  assert.equal(preview.visible_segments, 6);
  assert.equal(preview.suppressed_segments, 0);
  assert.equal(preview.tombstones_written, 0);
});

test("disconnect hides source locators and requests invalidation without claim deletion", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const preview = previewSyntheticSourceLifecycle(bundles, [
    { source_id: "fixture-chatgpt-01", action: "disconnect_source" },
  ]);
  const disconnected = preview.source_states.find(s => s.source_id === "fixture-chatgpt-01");
  assert.equal(disconnected.would_allow_new_source_reads, false);
  assert.equal(disconnected.would_allow_pending_review, false);
  assert.equal(disconnected.would_invalidate_source_derivatives, true);
  assert.equal(disconnected.operation_completed, false);
  assert.equal(preview.visible_segments, 3);
  assert.equal(preview.suppressed_segments, 3);
  assert.equal(disconnected.visible_segments, 0);
  assert.equal(disconnected.suppressed_segments, 3);
  assert.ok(preview.visible_entries.every(entry =>
    entry.locator.source_id === "fixture-claude-01"));
  assert.equal(preview.claims_created, 0);
  assert.equal(preview.review_outcomes_written, 0);
});

test("revoked import consent blocks pending review but does not claim completed removal", () => {
  const preview = previewSyntheticSourceLifecycle(
    [fixture("chatgpt"), fixture("claude")], [
      { source_id: "fixture-claude-01", action: "revoke_import_consent" },
    ]);
  const revoked = preview.source_states.find(s => s.source_id === "fixture-claude-01");
  assert.equal(revoked.would_allow_pending_review, false);
  assert.equal(revoked.would_allow_new_source_reads, false);
  assert.equal(revoked.would_invalidate_source_derivatives, true);
  assert.equal(revoked.retention_recheck_required, true);
  assert.equal(revoked.reimport_blocked_pending_new_consent, true);
  assert.equal(revoked.independent_witness_required, true);
  assert.equal(revoked.operation_completed, false);
  assert.equal(revoked.durable_lifecycle_event_written, false);
  assert.equal(revoked.witness_confirmed, false);
  assert.equal(preview.visible_segments, 3);
  assert.ok(preview.visible_entries.every(entry =>
    entry.locator.source_id !== "fixture-claude-01"));
  assert.equal(preview.durable_lifecycle_events_written, 0);
});

test("erasure request stays fail-closed pending independently witnessed durable completion", () => {
  const preview = previewSyntheticSourceLifecycle(
    [fixture("chatgpt"), fixture("claude")], [
      { source_id: "fixture-chatgpt-01", action: "request_erasure" },
    ]);
  const removed = preview.source_states.find(s => s.source_id === "fixture-chatgpt-01");
  assert.equal(removed.action, "request_erasure");
  assert.equal(removed.would_allow_pending_review, false);
  assert.equal(removed.would_allow_new_source_reads, false);
  assert.equal(removed.would_invalidate_source_derivatives, true);
  assert.equal(removed.reimport_blocked_pending_new_consent, true);
  assert.equal(removed.independent_witness_required, true);
  assert.equal(removed.operation_completed, false);
  assert.equal(removed.witness_confirmed, false);
  assert.equal(preview.tombstones_written, 0);
  assert.equal(preview.durable_lifecycle_events_written, 0);
  assert.equal(preview.visible_segments, 3);
  assert.ok(preview.visible_entries.every(entry =>
    entry.locator.source_id !== "fixture-chatgpt-01"));
});

test("lifecycle scenarios isolate independent sources and do not change fixture inputs", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const scenarios = [
    { source_id: "fixture-claude-01", action: "pause_sync" },
    { source_id: "fixture-chatgpt-01", action: "disconnect_source" },
  ];
  const snapshot = JSON.stringify({ bundles, scenarios });
  const a = previewSyntheticSourceLifecycle(bundles, scenarios);
  const b = previewSyntheticSourceLifecycle(
    [...bundles].reverse(), [...scenarios].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.scenarios_applied, 2);
  assert.equal(a.visible_segments, 3);
  assert.equal(a.suppressed_segments, 3);
  assert.equal(JSON.stringify({ bundles, scenarios }), snapshot);
  assert.equal(a.real_import_enabled, false);
});

test("lifecycle preview rejects unknown duplicate malformed and non-synthetic scenarios", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const valid = { source_id: "fixture-chatgpt-01", action: "pause_sync" };
  for (const invalid of [
    null, 0, [], "disconnect_source",
    { source_id: "fixture-chatgpt-01" },
    { source_id: "fixture-chatgpt-01", action: "confirm" },
    { source_id: "not-found", action: "pause_sync" },
    { ...valid, unexpected: "data" },
    { source_id: 1, action: "pause_sync" },
    { source_id: "fixture-chatgpt-01", action: null },
    Object.assign(Object.create(null), { source_id: "fixture-chatgpt-01" }),
  ]) {
    assert.throws(() => previewSyntheticSourceLifecycle(bundles, [invalid]),
      /Synthetic lifecycle:/);
  }
  for (const invalid of [null, false, {}, "pause_sync", [valid, valid],
    [valid, valid, valid]]) {
    assert.throws(() => previewSyntheticSourceLifecycle(bundles, invalid),
      /Synthetic lifecycle:/);
  }
  assert.throws(() => previewSyntheticSourceLifecycle(
    [bundles[0], { ...bundles[1], synthetic_fixture: false }], [valid]),
    /unsupported or non-synthetic bundle/);
});


test("lifecycle action input remains a strict string enum", () => {
  const bundles = [fixture("chatgpt"), fixture("claude")];
  const source_id = "fixture-chatgpt-01";
  for (const action of [
    "pause_sync", "disconnect_source", "revoke_import_consent", "request_erasure",
  ]) {
    const report = previewSyntheticSourceLifecycle(bundles, [{ source_id, action }]);
    assert.equal(report.source_states.find(source => source.source_id === source_id).action, action);
    assert.equal(report.scenarios_applied, 1);
    assert.equal(report.real_import_enabled, false);
  }
  for (const action of [
    ["pause_sync"], ["request_erasure"], ["active"], ["pause_sync", "request_erasure"],
    { toString: () => "pause_sync" }, new String("pause_sync"),
    "active", "", "PAUSE_SYNC", null, undefined, true, 1, Symbol("pause_sync"),
  ]) {
    assert.throws(() => previewSyntheticSourceLifecycle(bundles, [{ source_id, action }]),
      /Synthetic lifecycle: invalid lifecycle scenario/);
  }
});

test("fixture-only lifecycle CLI compares actions without raw text, writes or inputs", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/lifecycle-preview-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-lifecycle-"));
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
    assert.equal(report.synthetic_fixture_only, true);
    assert.deepEqual(report.scenarios.map(s => s.action), [
      "pause_sync", "disconnect_source", "revoke_import_consent", "request_erasure",
    ]);
    assert.equal(report.scenarios[0].would_allow_pending_review, true);
    assert.ok(report.scenarios.slice(1).every(s =>
      s.would_allow_pending_review === false && s.operation_completed === false));
    assert.ok(report.scenarios.slice(2).every(s => s.independent_witness_required));
    assert.equal(report.durable_lifecycle_events_written, 0);
    assert.equal(report.tombstones_written, 0);
    assert.equal(report.real_import_enabled, false);
    for (const content of ["fictional garden", "silver spaceship", "blue gate is open",
      "content_sha256", "bundle_digest"]) {
      assert.ok(!utc.stdout.includes(content), content);
    }
    const rejected = invoke(["../../private-export.json"], "UTC");
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout, "");
    assert.deepEqual(readdirSync(root), [], "lifecycle CLI must never persist state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("synthetic restore preflight requires replay for an older snapshot without releasing content", () => {
  const state = makeSyntheticRestoreFixture();
  const before = JSON.stringify(state);
  const report = previewSyntheticRestorePreflight(state);
  assert.equal(report.synthetic_fixture_only, true);
  assert.equal(report.mode, "offline_restore_preflight_rehearsal");
  assert.equal(report.preflight_status, "requires_replay_and_revalidation");
  assert.equal(report.reason, null);
  assert.equal(report.pending_replay_count, 2);
  assert.deepEqual(report.pending_replay_events, [
    { sequence: 1, opaque_source_id: "fictional-source-a", action: "request_erasure" },
    { sequence: 2, opaque_source_id: "fictional-source-b", action: "revoke_import_consent" },
  ]);
  assert.equal(report.replay_completed, false);
  assert.equal(report.actual_restore_applied, false);
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.actual_witness_contacted, false);
  assert.equal(report.durable_events_written, 0);
  assert.equal(report.tombstones_written, 0);
  assert.equal(report.claims_created, 0);
  assert.equal(report.real_import_enabled, false);
  assert.equal(JSON.stringify(state), before);
  const serialized = JSON.stringify(report);
  for (const forbidden of ["bundle_digest", "content_sha256", "fictional garden",
    "silver spaceship", "previous_digest", "applied_digest", "witness_digest"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test("a coherent old snapshot plus old registry is blocked by newer external witness", () => {
  const fixture = makeSyntheticRestoreFixture();
  const restored = structuredClone(fixture);
  restored.registry = restored.registry.slice(0, 1);
  const report = previewSyntheticRestorePreflight(restored);
  assert.equal(report.preflight_status, "blocked");
  assert.equal(report.reason, "registry_behind_external_witness");
  assert.equal(report.pending_replay_count, 0);
  assert.deepEqual(report.pending_replay_events, []);
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.replay_completed, false);
});

test("unavailable witness unverified witness and missing key all fail closed", () => {
  const fixture = makeSyntheticRestoreFixture();
  const variations = [
    [{ ...fixture, witness: null }, "witness_unavailable_or_invalid"],
    [{ ...fixture, witness: { sequence: 1, digest: "garbage" } }, "witness_unavailable_or_invalid"],
    [{ ...fixture, toy_independent_witness_verified: false }, "witness_unverified"],
    [{ ...fixture, toy_key_available: false }, "key_unavailable"],
  ];
  for (const [state, reason] of variations) {
    const report = previewSyntheticRestorePreflight(state);
    assert.equal(report.reason, reason);
    assert.equal(report.preflight_status, "blocked");
    assert.equal(report.pending_replay_count, 0);
    assert.equal(report.data_release_authorized, false);
    assert.equal(report.actual_witness_contacted, false);
  }
});

test("toy registry sequence gap and changed event metadata fail closed", () => {
  const base = makeSyntheticRestoreFixture();
  const gap = structuredClone(base);
  gap.registry[0].sequence = 2;
  assert.equal(previewSyntheticRestorePreflight(gap).reason, "registry_sequence_gap");
  const forgedAction = structuredClone(base);
  forgedAction.registry[0].action = "revoke_import_consent";
  assert.equal(previewSyntheticRestorePreflight(forgedAction).reason, "registry_chain_mismatch");
  const wrongPrior = structuredClone(base);
  wrongPrior.registry[1].previous_digest = "f".repeat(64);
  assert.equal(previewSyntheticRestorePreflight(wrongPrior).reason, "registry_chain_mismatch");
  const wrongDigest = structuredClone(base);
  wrongDigest.registry[0].digest = "f".repeat(64);
  assert.equal(previewSyntheticRestorePreflight(wrongDigest).reason, "registry_chain_mismatch");
});

test("toy witness mismatch and unanchored registry tail block release", () => {
  const base = makeSyntheticRestoreFixture();
  const staleWitness = structuredClone(base);
  staleWitness.witness = {
    sequence: 1, digest: staleWitness.registry[0].digest,
  };
  assert.equal(previewSyntheticRestorePreflight(staleWitness).reason,
    "registry_has_unwitnessed_tail");
  const mismatching = structuredClone(base);
  mismatching.witness.digest = "e".repeat(64);
  assert.equal(previewSyntheticRestorePreflight(mismatching).reason,
    "external_witness_digest_mismatch");
  const ahead = structuredClone(base);
  ahead.witness.sequence = 3;
  assert.equal(previewSyntheticRestorePreflight(ahead).reason,
    "registry_behind_external_witness");
});

test("restore cursor must match the observed registry checkpoint", () => {
  const base = makeSyntheticRestoreFixture();
  const ahead = structuredClone(base);
  ahead.snapshot.applied_sequence = 3;
  assert.equal(previewSyntheticRestorePreflight(ahead).reason, "restored_snapshot_ahead");
  const badDigest = structuredClone(base);
  badDigest.snapshot.applied_sequence = 1;
  assert.equal(previewSyntheticRestorePreflight(badDigest).reason,
    "restored_snapshot_digest_mismatch");
  const current = structuredClone(base);
  current.snapshot = {
    applied_sequence: current.witness.sequence,
    applied_digest: current.witness.digest,
  };
  const report = previewSyntheticRestorePreflight(current);
  assert.equal(report.preflight_status, "checks_passed_in_toy_only");
  assert.equal(report.pending_replay_count, 0);
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.replay_completed, false);
});

test("toy restore fixture and registry accept only scoped nonpersonal metadata", () => {
  const base = makeSyntheticRestoreFixture();
  for (const modify of [
    state => { state.registry[0].action = ["request_erasure"]; },
    state => { state.registry[0].action = "pause_sync"; },
    state => { state.registry[0].opaque_source_id = "some@example.com"; },
    state => { state.registry[0].opaque_source_id = ["fictional-source-a"]; },
    state => { state.registry[0].text = "private personal information"; },
    state => { state.registry[0].sequence = 1.5; },
    state => { state.registry[1].digest = undefined; },
    state => { state.snapshot.applied_sequence = -1; },
    state => { state.snapshot.extra = "bad"; },
    state => { state.registry = Array.from({ length: 17 }, () => state.registry[0]); },
    state => { state.toy_independent_witness_verified = "true"; },
    state => { state.toy_key_available = "true"; },
    state => { state.extra = "bad"; },
  ]) {
    const invalid = structuredClone(base);
    modify(invalid);
    assert.throws(() => previewSyntheticRestorePreflight(invalid),
      /Synthetic restore:/);
  }
  for (const invalid of [null, [], {}, false, "fixture"]) {
    assert.throws(() => previewSyntheticRestorePreflight(invalid),
      /Synthetic restore:/);
  }
});

test("empty fictional registry checkpoint also requires independently verified toy witness", () => {
  const base = makeSyntheticRestoreFixture();
  const genesis = "0".repeat(64);
  const noEvents = {
    ...base, registry: [],
    snapshot: { applied_sequence: 0, applied_digest: genesis },
    witness: { sequence: 0, digest: genesis },
  };
  const allowed = previewSyntheticRestorePreflight(noEvents);
  assert.equal(allowed.preflight_status, "checks_passed_in_toy_only");
  assert.equal(allowed.data_release_authorized, false);
  const unavailable = previewSyntheticRestorePreflight({ ...noEvents, witness: null });
  assert.equal(unavailable.preflight_status, "blocked");
  assert.equal(unavailable.reason, "witness_unavailable_or_invalid");
});

test("read-only restore preflight CLI is deterministic and denies custom input", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/restore-preflight-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-restore-"));
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
    assert.equal(report.synthetic_fixture_only, true);
    assert.equal(report.old_snapshot_status, "requires_replay_and_revalidation");
    assert.equal(report.toy_pending_replay_events, 2);
    assert.equal(report.old_registry_rollback, "registry_behind_external_witness");
    assert.equal(report.missing_witness, "witness_unavailable_or_invalid");
    assert.equal(report.missing_key, "key_unavailable");
    assert.equal(report.current_snapshot_status, "checks_passed_in_toy_only");
    assert.equal(report.data_release_authorized, false);
    assert.equal(report.real_import_enabled, false);
    for (const forbidden of ["fictional garden", "silver spaceship",
      "content_sha256", "applied_digest", "previous_digest"]) {
      assert.ok(!utc.stdout.includes(forbidden), forbidden);
    }
    const denied = invoke(["../../private-export.json"], "UTC");
    assert.equal(denied.status, 2);
    assert.equal(denied.stdout, "");
    assert.deepEqual(readdirSync(root), [], "restore preview must not persist anything");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("toy restore plan lists separate erasure and consent revocation obligations", () => {
  const fixture = makeSyntheticRestoreFixture();
  const unchanged = JSON.stringify(fixture);
  const report = previewSyntheticRestoreReplayPlan(fixture);
  assert.equal(report.synthetic_fixture_only, true);
  assert.equal(report.plan_status, "requires_hypothetical_replay");
  assert.equal(report.pending_events_to_reconcile, 2);
  assert.deepEqual(report.event_obligations.map(({ sequence, opaque_source_id, action }) =>
    [sequence, opaque_source_id, action]), [
    [1, "fictional-source-a", "request_erasure"],
    [2, "fictional-source-b", "revoke_import_consent"],
  ]);
  assert.ok(report.event_obligations.every(event => event.completed === false));
  assert.deepEqual(report.event_obligations[0].required_checks, [
    "remove_source_and_exclusively_derived_claims",
    "prune_multi_source_evidence_and_revalidate_remaining_basis",
    "invalidate_dependent_search_cache_embeddings_exports_summaries",
    "retain_independent_anti_resurrection_tombstone_witness",
  ]);
  assert.deepEqual(report.event_obligations[1].required_checks, [
    "stop_source_processing_and_ai_egress",
    "recheck_separate_valid_retention_and_evidence_basis",
    "purge_unauthorized_proposals_copies_and_derivatives",
    "invalidate_and_revalidate_dependent_search_cache_ai_outputs",
  ]);
  assert.equal(JSON.stringify(fixture), unchanged);
});

test("no fictional recovery plan authorizes release or claims completed work", () => {
  const fixture = makeSyntheticRestoreFixture();
  const final = { ...fixture,
    snapshot: { applied_sequence: fixture.witness.sequence, applied_digest: fixture.witness.digest } };
  const rollback = structuredClone(fixture);
  rollback.registry.pop();
  const cases = [
    previewSyntheticRestoreReplayPlan(fixture),
    previewSyntheticRestoreReplayPlan(final),
    previewSyntheticRestoreReplayPlan(rollback),
    previewSyntheticRestoreReplayPlan({ ...fixture, witness: null }),
    previewSyntheticRestoreReplayPlan({ ...fixture, toy_key_available: false }),
  ];
  for (const report of cases) {
    assert.equal(report.data_release_authorized, false);
    assert.equal(report.all_release_gates_satisfied, false);
    assert.equal(report.replay_completed, false);
    assert.equal(report.actual_restore_applied, false);
    assert.equal(report.actual_witness_contacted, false);
    assert.equal(report.durable_events_written, 0);
    assert.equal(report.tombstones_written, 0);
    assert.equal(report.claims_created, 0);
    assert.equal(report.real_import_enabled, false);
    assert.ok(report.global_release_gates.includes(
      "revalidate_source_acl_consent_retention_and_claim_evidence"));
  }
});

test("rolled-back fictional registry never yields per-source replay details", () => {
  const fixture = makeSyntheticRestoreFixture();
  const rollback = structuredClone(fixture);
  rollback.registry = rollback.registry.slice(0, 1);
  const report = previewSyntheticRestoreReplayPlan(rollback);
  assert.equal(report.plan_status, "blocked");
  assert.equal(report.reason, "registry_behind_external_witness");
  assert.equal(report.pending_events_to_reconcile, 0);
  assert.deepEqual(report.event_obligations, []);
  assert.equal(report.source_specific_work_disclosed, false);
  const json = JSON.stringify(report);
  assert.ok(!json.includes("fictional-source-a"));
  assert.ok(!json.includes("fictional-source-b"));
  assert.ok(!json.includes("request_erasure"));
  assert.ok(!json.includes("revoke_import_consent"));
});

test("missing witness, key and tampered event all prevent replay planning", () => {
  const fixture = makeSyntheticRestoreFixture();
  const tampered = structuredClone(fixture);
  tampered.registry[0].action = "revoke_import_consent";
  for (const [state, reason] of [
    [{ ...fixture, witness: null }, "witness_unavailable_or_invalid"],
    [{ ...fixture, toy_independent_witness_verified: false }, "witness_unverified"],
    [{ ...fixture, toy_key_available: false }, "key_unavailable"],
    [tampered, "registry_chain_mismatch"],
  ]) {
    const report = previewSyntheticRestoreReplayPlan(state);
    assert.equal(report.plan_status, "blocked");
    assert.equal(report.reason, reason);
    assert.deepEqual(report.event_obligations, []);
    assert.equal(report.source_specific_work_disclosed, false);
  }
});

test("a restored fictional snapshot one event behind has only one pending obligation", () => {
  const fixture = makeSyntheticRestoreFixture();
  fixture.snapshot = {
    applied_sequence: 1,
    applied_digest: fixture.registry[0].digest,
  };
  const report = previewSyntheticRestoreReplayPlan(fixture);
  assert.equal(report.pending_events_to_reconcile, 1);
  assert.deepEqual(report.event_obligations.map(e => e.action), ["revoke_import_consent"]);
  assert.equal(report.event_obligations[0].sequence, 2);
  assert.equal(report.data_release_authorized, false);
});

test("matching toy snapshot still requires ACL and derivative revalidation", () => {
  const fixture = makeSyntheticRestoreFixture();
  fixture.snapshot = {
    applied_sequence: fixture.witness.sequence,
    applied_digest: fixture.witness.digest,
  };
  const report = previewSyntheticRestoreReplayPlan(fixture);
  assert.equal(report.plan_status, "preflight_passed_revalidation_still_required");
  assert.equal(report.pending_events_to_reconcile, 0);
  assert.deepEqual(report.event_obligations, []);
  assert.equal(report.source_specific_work_disclosed, false);
  assert.equal(report.all_release_gates_satisfied, false);
  assert.equal(report.data_release_authorized, false);
});

test("restore replay plan strictly inherits fixture preflight validation", () => {
  const fixture = makeSyntheticRestoreFixture();
  for (const bad of [
    null,
    {},
    { ...fixture, witness: { sequence: 2, digest: "nonsense" } },
    { ...fixture, registry: [{ ...fixture.registry[0], extra: "secret" }] },
    { ...fixture, snapshot: { ...fixture.snapshot, applied_sequence: -1 } },
  ]) {
    if (bad === null || !bad.snapshot || bad.registry[0]?.extra ||
        bad.snapshot?.applied_sequence === -1) {
      assert.throws(() => previewSyntheticRestoreReplayPlan(bad), /Synthetic restore:/);
    } else {
      assert.equal(previewSyntheticRestoreReplayPlan(bad).plan_status, "blocked");
    }
  }
});

test("restore replay CLI is deterministic, fixture-only and read-only", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/restore-replay-plan-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-replayplan-"));
  const invoke = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const a = invoke([], "UTC");
    const b = invoke([], "Europe/Prague");
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout, b.stdout);
    const report = JSON.parse(a.stdout);
    assert.equal(report.synthetic_fixture_only, true);
    assert.equal(report.pending_replay_obligations.length, 2);
    assert.equal(report.blocked_rollback_reason, "registry_behind_external_witness");
    assert.equal(report.blocked_reveals_event_details, false);
    assert.equal(report.matched_snapshot_still_requires_revalidation, true);
    assert.equal(report.data_release_authorized, false);
    assert.equal(report.replay_completed, false);
    assert.equal(report.actual_witness_contacted, false);
    assert.equal(report.real_import_enabled, false);
    for (const forbidden of ["applied_digest", "previous_digest", "bundle_digest",
      "content_sha256", "fictional garden", "silver spaceship"]) {
      assert.ok(!a.stdout.includes(forbidden), forbidden);
    }
    const rejected = invoke(["../../private-export.json"], "UTC");
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout, "");
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
