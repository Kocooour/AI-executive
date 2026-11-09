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
import { makeSyntheticDerivativeFixture, previewSyntheticDerivativeImpact } from "../scripts/humanwiki-synthetic/derivative-impact-preview.mjs";
import { bindSyntheticDerivativeRevision, recheckSyntheticDerivativeRevision } from "../scripts/humanwiki-synthetic/derivative-revision.mjs";
import { bindSyntheticEpochFence, recheckSyntheticEpochFence, rehearseSyntheticFenceWindow, makeSyntheticEpochFenceFixture } from "../scripts/humanwiki-synthetic/epoch-fence-rehearsal.mjs";
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

test("fictional dependency impact distinguishes erased-only, mixed and consent-only claims", () => {
  const state = makeSyntheticRestoreFixture();
  const original = JSON.stringify(state);
  const report = previewSyntheticDerivativeImpact(state);
  const by = new Map(report.claim_impacts.map(item => [item.claim_id, item]));
  assert.equal(report.impact_status, "hypothetical_impacts_only");
  assert.equal(by.get("fictional-claim-a").disposition, "would_remove_exclusively_erased_claim");
  assert.deepEqual(by.get("fictional-claim-a").unaffected_source_candidates, []);
  assert.equal(by.get("fictional-claim-ac").disposition,
    "would_prune_erased_evidence_and_revalidate_all_remaining");
  assert.deepEqual(by.get("fictional-claim-ac").unaffected_source_candidates,
    ["fictional-source-c"]);
  assert.equal(by.get("fictional-claim-ab").disposition,
    "would_prune_erased_evidence_and_revalidate_all_remaining");
  assert.deepEqual(by.get("fictional-claim-ab").unaffected_source_candidates, [],
    "a revoked source is not automatically independent or authorized evidence");
  assert.deepEqual(by.get("fictional-claim-ab").revoked_source_references,
    ["fictional-source-b"]);
  assert.equal(by.get("fictional-claim-b").disposition,
    "would_hold_for_retention_and_consent_review");
  assert.equal(by.get("fictional-claim-bc").disposition,
    "would_hold_for_retention_and_consent_review");
  assert.equal(by.get("fictional-claim-c").disposition,
    "unchanged_source_but_global_revalidation_required");
  assert.equal(by.get("fictional-claim-c").would_invalidate_dependent_artifacts, false);
  assert.ok(report.claim_impacts.every(item =>
    item.completed === false && item.independently_authorized_evidence_proven === false));
  assert.equal(JSON.stringify(state), original);
});

test("fictional derivative invalidation propagates through caches summaries and exports", () => {
  const report = previewSyntheticDerivativeImpact(makeSyntheticRestoreFixture());
  const by = new Map(report.artifact_impacts.map(item => [item.artifact_id, item]));
  for (const id of [
    "fictional-search-a", "fictional-cache-ac", "fictional-embedding-bc",
    "fictional-summary-mixed", "fictional-export-mixed", "fictional-link-a",
    "fictional-cache-b", "fictional-export-ab",
  ]) assert.equal(by.get(id).would_invalidate, true, id);
  assert.deepEqual(by.get("fictional-export-mixed").dependency_ids,
    ["fictional-summary-mixed"]);
  assert.equal(by.get("fictional-autocomplete-c").would_invalidate, false);
  assert.equal(by.get("fictional-search-c").would_invalidate, false);
  assert.ok(report.artifact_impacts.every(item =>
    item.must_revalidate_before_any_release &&
    !item.invalidation_completed && !item.served));
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.actual_deletions_performed, 0);
  assert.equal(report.actual_invalidation_performed, 0);
  assert.equal(report.actual_replay_performed, false);
  assert.equal(report.actual_witness_contacted, false);
  assert.equal(report.real_import_enabled, false);
});

test("fictional current snapshot does not bypass already-witnessed revocation impacts", () => {
  const state = makeSyntheticRestoreFixture();
  const old = previewSyntheticDerivativeImpact(state);
  const alreadyApplied = structuredClone(state);
  alreadyApplied.snapshot = {
    applied_sequence: state.witness.sequence, applied_digest: state.witness.digest,
  };
  assert.equal(previewSyntheticRestoreReplayPlan(alreadyApplied).pending_events_to_reconcile, 0);
  const fresh = previewSyntheticDerivativeImpact(alreadyApplied);
  assert.deepEqual(fresh.claim_impacts, old.claim_impacts);
  assert.deepEqual(fresh.artifact_impacts, old.artifact_impacts);
  assert.equal(fresh.data_release_authorized, false);
});

test("blocked preflight never discloses fictional claims, artifacts or dependencies", () => {
  const state = makeSyntheticRestoreFixture();
  const rolledBack = structuredClone(state);
  rolledBack.registry.pop();
  const damaged = structuredClone(state);
  damaged.registry[0].action = "revoke_import_consent";
  for (const [input, reason] of [
    [rolledBack, "registry_behind_external_witness"],
    [{ ...state, witness: null }, "witness_unavailable_or_invalid"],
    [{ ...state, toy_key_available: false }, "key_unavailable"],
    [{ ...state, toy_independent_witness_verified: false }, "witness_unverified"],
    [damaged, "registry_chain_mismatch"],
  ]) {
    const report = previewSyntheticDerivativeImpact(input);
    assert.equal(report.impact_status, "blocked");
    assert.equal(report.reason, reason);
    assert.deepEqual(report.claim_impacts, []);
    assert.deepEqual(report.artifact_impacts, []);
    assert.equal(report.source_specific_details_disclosed, false);
    assert.equal(report.data_release_authorized, false);
    const serialized = JSON.stringify(report);
    for (const forbidden of ["fictional-claim", "fictional-source",
      "fictional-export", "fictional-summary"]) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  }
});

test("synthetic dependency graph rejects private unknown duplicate or malformed claims", () => {
  const state = makeSyntheticRestoreFixture();
  for (const change of [
    graph => { graph.claims[0].id = "someone@example.com"; },
    graph => { graph.claims[1].id = graph.claims[0].id; },
    graph => { graph.claims[0].evidence = []; },
    graph => { graph.claims[0].evidence = ["fictional-source-a", "fictional-source-a"]; },
    graph => { graph.claims[0].evidence = ["someone@example.com"]; },
    graph => { graph.claims[0].evidence = [["fictional-source-a"]]; },
    graph => { graph.claims[0].text = "private"; },
    graph => { graph.claims[0] = null; },
    graph => { graph.claims = [false]; },
    graph => { graph.claims.push(structuredClone(graph.claims[0])); },
    graph => { graph.extra = "private"; },
  ]) {
    const graph = makeSyntheticDerivativeFixture();
    change(graph);
    assert.throws(() => previewSyntheticDerivativeImpact(state, graph),
      /Synthetic dependency impact:/);
  }
  for (const graph of [null, false, "graph", {}, [], { claims: [], artifacts: null }]) {
    assert.throws(() => previewSyntheticDerivativeImpact(state, graph),
      /Synthetic dependency impact:/);
  }
});

test("synthetic dependency graph rejects unknown parents kinds cycles and duplicates", () => {
  const state = makeSyntheticRestoreFixture();
  for (const change of [
    graph => { graph.artifacts[0].id = "personal-export.pdf"; },
    graph => { graph.artifacts[0].kind = "approved"; },
    graph => { graph.artifacts[0].depends_on = ["missing-claim"]; },
    graph => { graph.artifacts[0].depends_on = []; },
    graph => { graph.artifacts[0].depends_on = ["fictional-claim-a", "fictional-claim-a"]; },
    graph => { graph.artifacts[0].depends_on = ["fictional-search-a"]; },
    graph => { graph.artifacts[0].depends_on = ["fictional-cache-ac"];
               graph.artifacts[1].depends_on = ["fictional-search-a"]; },
    graph => { graph.artifacts[0].text = "private"; },
    graph => { graph.artifacts[1].id = graph.artifacts[0].id; },
    graph => { graph.artifacts.push(structuredClone(graph.artifacts[0])); },
    graph => { graph.artifacts[0] = null; },
  ]) {
    const graph = makeSyntheticDerivativeFixture();
    change(graph);
    assert.throws(() => previewSyntheticDerivativeImpact(state, graph),
      /Synthetic dependency impact:/);
  }
});

test("synthetic dependency preview is deterministic for reordered graph and leaves inputs unchanged", () => {
  const state = makeSyntheticRestoreFixture();
  const graph = makeSyntheticDerivativeFixture();
  const before = JSON.stringify({ state, graph });
  const normal = previewSyntheticDerivativeImpact(state, graph);
  const reordered = structuredClone(graph);
  reordered.claims.reverse();
  reordered.artifacts.reverse();
  for (const claim of reordered.claims) claim.evidence.reverse();
  for (const artifact of reordered.artifacts) artifact.depends_on.reverse();
  assert.deepEqual(previewSyntheticDerivativeImpact(state, reordered), normal);
  assert.equal(JSON.stringify({ state, graph }), before);
  const serialized = JSON.stringify(normal);
  for (const sensitive of ["bundle_digest", "content_sha256", "applied_digest",
    "previous_digest", "fictional garden", "silver spaceship", "some@example.com"]) {
    assert.ok(!serialized.includes(sensitive), sensitive);
  }
});

test("empty toy revocation registry retains global holds and never authorizes access", () => {
  const state = makeSyntheticRestoreFixture();
  const genesis = "0".repeat(64);
  state.registry = [];
  state.witness = { sequence: 0, digest: genesis };
  state.snapshot = { applied_sequence: 0, applied_digest: genesis };
  const report = previewSyntheticDerivativeImpact(state);
  assert.equal(report.impact_status, "hypothetical_impacts_only");
  assert.ok(report.claim_impacts.every(item =>
    item.disposition === "unchanged_source_but_global_revalidation_required"));
  assert.ok(report.artifact_impacts.every(item =>
    !item.would_invalidate && item.must_revalidate_before_any_release));
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.independently_authorized_evidence_proven, false);
  assert.equal(report.claims_created, 0);
});

test("fixture-only derivative impact CLI rejects arguments and writes nothing", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/derivative-impact-preview-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-derivatives-"));
  const run = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const utc = run([], "UTC"), prague = run([], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(prague.status, 0, prague.stderr);
    assert.equal(utc.stdout, prague.stdout);
    const value = JSON.parse(utc.stdout);
    assert.equal(value.synthetic_fixture_only, true);
    assert.equal(value.claim_impacts.length, 6);
    assert.equal(value.artifact_impacts.length, 10);
    assert.equal(value.blocked_rollback_reason, "registry_behind_external_witness");
    assert.equal(value.blocked_disclosed_sources, false);
    assert.equal(value.incomplete_graph_reason, "fictional_dependency_coverage_incomplete");
    assert.equal(value.incomplete_graph_disclosed_sources, false);
    assert.equal(value.fictional_fixture_manifest_matched, true);
    assert.equal(value.production_dependency_coverage_verified, false);
    assert.equal(value.witness_current_does_not_waive_revalidation, true);
    assert.equal(value.data_release_authorized, false);
    assert.equal(value.actual_deletions_performed, 0);
    assert.equal(value.actual_invalidation_performed, 0);
    assert.equal(value.actual_replay_performed, false);
    assert.equal(value.real_import_enabled, false);
    for (const forbidden of ["applied_digest", "previous_digest", "bundle_digest",
      "content_sha256", "fictional garden", "silver spaceship"]) {
      assert.ok(!utc.stdout.includes(forbidden), forbidden);
    }
    const denied = run(["../../real-export.json"], "UTC");
    assert.equal(denied.status, 2);
    assert.equal(denied.stdout, "");
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical fictional dependency manifest is matched without granting real-data coverage", () => {
  const state = makeSyntheticRestoreFixture();
  const graph = makeSyntheticDerivativeFixture();
  const original = JSON.stringify({ state, graph });
  const result = previewSyntheticDerivativeImpact(state, graph);
  assert.equal(result.impact_status, "hypothetical_impacts_only");
  assert.equal(result.fictional_fixture_manifest_matched, true);
  assert.equal(result.production_dependency_coverage_verified, false);
  assert.equal(result.data_release_authorized, false);
  assert.equal(result.claim_impacts.length, 6);
  assert.equal(result.artifact_impacts.length, 10);
  assert.equal(JSON.stringify({ state, graph }), original);
});

test("omitted fictional claims or artifacts cannot masquerade as complete graph coverage", () => {
  const state = makeSyntheticRestoreFixture();
  const cases = [
    graph => { graph.artifacts = graph.artifacts.filter(x => x.id !== "fictional-link-a"); },
    graph => { graph.artifacts = graph.artifacts.filter(x => x.id !== "fictional-export-mixed"); },
    graph => {
      graph.claims = graph.claims.filter(x => x.id !== "fictional-claim-c");
      graph.artifacts = graph.artifacts.filter(x =>
        x.id !== "fictional-autocomplete-c" && x.id !== "fictional-search-c");
    },
    graph => { graph.claims = []; graph.artifacts = []; },
  ];
  for (const mutate of cases) {
    const graph = makeSyntheticDerivativeFixture();
    mutate(graph);
    const result = previewSyntheticDerivativeImpact(state, graph);
    assert.equal(result.impact_status, "blocked");
    assert.equal(result.reason, "fictional_dependency_coverage_incomplete");
    assert.equal(result.fictional_fixture_manifest_matched, false);
    assert.equal(result.production_dependency_coverage_verified, false);
    assert.deepEqual(result.claim_impacts, []);
    assert.deepEqual(result.artifact_impacts, []);
    assert.equal(result.source_specific_details_disclosed, false);
    assert.equal(result.data_release_authorized, false);
    assert.ok(!JSON.stringify(result).includes("fictional-claim-a"));
    assert.ok(!JSON.stringify(result).includes("fictional-source-a"));
  }
});

test("missing known evidence on a mixed claim is a coverage failure, not unaffected evidence", () => {
  const state = makeSyntheticRestoreFixture();
  for (const evidence of [
    ["fictional-source-c"], ["fictional-source-a"], ["fictional-source-b"],
  ]) {
    const graph = makeSyntheticDerivativeFixture();
    graph.claims.find(x => x.id === "fictional-claim-ac").evidence = evidence;
    const result = previewSyntheticDerivativeImpact(state, graph);
    assert.equal(result.impact_status, "blocked");
    assert.equal(result.reason, "fictional_dependency_coverage_incomplete");
    assert.deepEqual(result.claim_impacts, []);
    assert.equal(result.data_release_authorized, false);
  }
});

test("repointed valid graph edges fail coverage even if shape and cycles are valid", () => {
  const state = makeSyntheticRestoreFixture();
  for (const mutate of [
    graph => { graph.artifacts.find(x => x.id === "fictional-cache-ac").depends_on = ["fictional-claim-b"]; },
    graph => { graph.artifacts.find(x => x.id === "fictional-summary-mixed").depends_on =
      ["fictional-embedding-bc"]; },
    graph => { graph.artifacts.find(x => x.id === "fictional-export-mixed").depends_on =
      ["fictional-cache-b"]; },
    graph => { graph.artifacts.find(x => x.id === "fictional-cache-ac").depends_on =
      ["fictional-claim-ac", "fictional-claim-bc"]; },
  ]) {
    const graph = makeSyntheticDerivativeFixture();
    mutate(graph);
    const result = previewSyntheticDerivativeImpact(state, graph);
    assert.equal(result.reason, "fictional_dependency_coverage_incomplete");
    assert.equal(result.impact_status, "blocked");
    assert.equal(result.artifact_impacts.length, 0);
    assert.equal(result.source_specific_details_disclosed, false);
  }
});

test("failed restore gate suppresses impact even before malformed graph examination", () => {
  const state = makeSyntheticRestoreFixture();
  state.witness = null;
  const result = previewSyntheticDerivativeImpact(state, { sensitive: "do not inspect" });
  assert.equal(result.impact_status, "blocked");
  assert.equal(result.reason, "witness_unavailable_or_invalid");
  assert.equal(result.fictional_fixture_manifest_matched, false);
  assert.deepEqual(result.claim_impacts, []);
  assert.deepEqual(result.artifact_impacts, []);
  assert.equal(result.data_release_authorized, false);
  assert.equal(result.production_dependency_coverage_verified, false);
});

test("fictional dependency revision binds only the complete, checked toy inputs", () => {
  const state = makeSyntheticRestoreFixture();
  const graph = makeSyntheticDerivativeFixture();
  const before = JSON.stringify({ state, graph });
  const token = bindSyntheticDerivativeRevision(state, graph);
  assert.deepEqual(Object.keys(token).sort(), [
    "schema", "toy_graph_digest", "toy_restore_digest",
  ]);
  assert.equal(token.schema, "fictional_dependency_revision_v1");
  assert.match(token.toy_graph_digest, /^[0-9a-f]{64}$/);
  assert.match(token.toy_restore_digest, /^[0-9a-f]{64}$/);
  const result = recheckSyntheticDerivativeRevision(state, graph, token);
  assert.equal(result.revision_status, "toy_revision_matches_no_release");
  assert.equal(result.toy_binding_matches_current, true);
  assert.equal(result.source_specific_details_disclosed, false);
  assert.equal(result.graph_content_or_hash_disclosed, false);
  assert.equal(result.data_release_authorized, false);
  assert.equal(result.real_graph_revision_authenticated, false);
  assert.equal(result.actual_witness_contacted, false);
  assert.equal(result.actual_invalidation_performed, 0);
  assert.equal(result.actual_replay_performed, false);
  assert.equal(result.real_import_enabled, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(token.toy_graph_digest));
  assert.ok(!serialized.includes(token.toy_restore_digest));
  assert.ok(!serialized.includes("fictional-source-a"));
  assert.equal(JSON.stringify({ state, graph }), before);
});

test("fictional dependency revisions are insensitive to graph and edge ordering", () => {
  const state = makeSyntheticRestoreFixture();
  const graph = makeSyntheticDerivativeFixture();
  const token = bindSyntheticDerivativeRevision(state, graph);
  const reverse = structuredClone(graph);
  reverse.claims.reverse();
  reverse.artifacts.reverse();
  reverse.claims.forEach(c => c.evidence.reverse());
  reverse.artifacts.forEach(a => a.depends_on.reverse());
  assert.deepEqual(bindSyntheticDerivativeRevision(state, reverse), token);
  assert.equal(recheckSyntheticDerivativeRevision(state, reverse, token).toy_binding_matches_current, true);
});

test("new valid restore cursor invalidates an earlier toy dependency observation", () => {
  const state = makeSyntheticRestoreFixture();
  const graph = makeSyntheticDerivativeFixture();
  const token = bindSyntheticDerivativeRevision(state, graph);
  const advanced = structuredClone(state);
  advanced.snapshot = { applied_sequence: 1, applied_digest: advanced.registry[0].digest };
  const newer = recheckSyntheticDerivativeRevision(advanced, graph, token);
  assert.equal(previewSyntheticRestorePreflight(advanced).preflight_status,
    "requires_replay_and_revalidation");
  assert.equal(newer.revision_status, "stale_toy_revision_rejected");
  assert.equal(newer.toy_binding_matches_current, false);
  assert.equal(newer.data_release_authorized, false);
  advanced.snapshot = { applied_sequence: 2, applied_digest: advanced.witness.digest };
  assert.equal(recheckSyntheticDerivativeRevision(advanced, graph, token).revision_status,
    "stale_toy_revision_rejected");
  assert.equal(recheckSyntheticDerivativeRevision(state, graph, token).toy_binding_matches_current,
    true, "the original fixture remains unchanged");
});

test("coherently changed toy registry and witness invalidate prior revision binding", () => {
  const state = makeSyntheticRestoreFixture();
  const graph = makeSyntheticDerivativeFixture();
  const token = bindSyntheticDerivativeRevision(state, graph);
  const empty = structuredClone(state);
  const genesis = "0".repeat(64);
  empty.registry = [];
  empty.snapshot = { applied_sequence: 0, applied_digest: genesis };
  empty.witness = { sequence: 0, digest: genesis };
  assert.equal(previewSyntheticRestorePreflight(empty).preflight_status,
    "checks_passed_in_toy_only");
  const report = recheckSyntheticDerivativeRevision(empty, graph, token);
  assert.equal(report.revision_status, "stale_toy_revision_rejected");
  assert.equal(report.source_specific_details_disclosed, false);
  assert.equal(report.data_release_authorized, false);
});

test("missing or invalid current witness and incomplete graph refuse stale revision recheck", () => {
  const state = makeSyntheticRestoreFixture(), graph = makeSyntheticDerivativeFixture();
  const binding = bindSyntheticDerivativeRevision(state, graph);
  const truncated = structuredClone(graph);
  truncated.artifacts.pop();
  const redirected = structuredClone(graph);
  redirected.artifacts[0].depends_on = ["fictional-claim-b"];
  const tamperedRegistry = structuredClone(state);
  tamperedRegistry.registry[0].action = "revoke_import_consent";
  for (const [currentState, currentGraph] of [
    [state, truncated], [state, redirected],
    [{ ...state, witness: null }, graph],
    [{ ...state, toy_key_available: false }, graph],
    [{ ...state, toy_independent_witness_verified: false }, graph],
    [tamperedRegistry, graph],
  ]) {
    const result = recheckSyntheticDerivativeRevision(currentState, currentGraph, binding);
    assert.equal(result.revision_status, "blocked_by_current_preflight_or_coverage");
    assert.equal(result.toy_binding_matches_current, false);
    assert.equal(result.data_release_authorized, false);
    assert.equal(result.source_specific_details_disclosed, false);
    assert.equal(result.graph_content_or_hash_disclosed, false);
    assert.ok(!JSON.stringify(result).includes("fictional-source"));
  }
});

test("a blocked toy restore state takes precedence even over an invalid dependency graph", () => {
  const state = makeSyntheticRestoreFixture(), graph = makeSyntheticDerivativeFixture();
  const binding = bindSyntheticDerivativeRevision(state, graph);
  const badState = { ...state, witness: null };
  assert.equal(recheckSyntheticDerivativeRevision(badState, { unexpected: "private" }, binding)
    .revision_status, "blocked_by_current_preflight_or_coverage");
  assert.throws(() => bindSyntheticDerivativeRevision(badState, { unexpected: "private" }),
    /Synthetic dependency revision: cannot bind blocked/);
  assert.throws(() => bindSyntheticDerivativeRevision(state, { claims: [], artifacts: [] }),
    /Synthetic dependency revision: cannot bind blocked/);
});

test("invalid, extra or non-string fictional revision bindings fail closed", () => {
  const state = makeSyntheticRestoreFixture(), graph = makeSyntheticDerivativeFixture();
  const valid = bindSyntheticDerivativeRevision(state, graph);
  for (const invalid of [
    null, false, 0, [], {}, "green", [valid],
    { ...valid, extra: "bad" },
    { ...valid, schema: ["fictional_dependency_revision_v1"] },
    { ...valid, schema: "v2" },
    { ...valid, toy_graph_digest: ["a".repeat(64)] },
    { ...valid, toy_graph_digest: "a" },
    { ...valid, toy_restore_digest: null },
    { ...valid, toy_restore_digest: new String("a".repeat(64)) },
    Object.assign(Object.create(null), { schema: valid.schema }),
  ]) assert.throws(() => recheckSyntheticDerivativeRevision(state, graph, invalid),
    /Synthetic dependency revision: malformed toy revision binding/);
  const forged = { ...valid, toy_graph_digest: "f".repeat(64) };
  const result = recheckSyntheticDerivativeRevision(state, graph, forged);
  assert.equal(result.revision_status, "stale_toy_revision_rejected");
  assert.equal(result.data_release_authorized, false);
});

test("fictional revision CLI is deterministic, no-arg, no-write and never emits toy hashes", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/derivative-revision-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-version-"));
  const run = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const utc = run([], "UTC"), prague = run([], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(prague.status, 0, prague.stderr);
    assert.equal(utc.stdout, prague.stdout);
    const report = JSON.parse(utc.stdout);
    assert.equal(report.synthetic_fixture_only, true);
    assert.equal(report.unchanged_revision, "toy_revision_matches_no_release");
    assert.equal(report.reordered_graph, "toy_revision_matches_no_release");
    assert.equal(report.changed_snapshot, "stale_toy_revision_rejected");
    assert.equal(report.incomplete_graph, "blocked_by_current_preflight_or_coverage");
    assert.equal(report.missing_witness, "blocked_by_current_preflight_or_coverage");
    assert.equal(report.toy_binding_digest_served, false);
    assert.equal(report.real_graph_revision_authenticated, false);
    assert.equal(report.data_release_authorized, false);
    assert.equal(report.real_import_enabled, false);
    for (const forbidden of [
      "toy_graph_digest", "toy_restore_digest", "applied_digest", "previous_digest",
      "fictional-source-a", "fictional-claim-a", "private",
    ]) assert.ok(!utc.stdout.includes(forbidden), forbidden);
    const denied = run(["../../personal-export.json"], "UTC");
    assert.equal(denied.status, 2);
    assert.equal(denied.stdout, "");
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fictional epoch fence binds a checked toy frame and never authorizes release", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 1);
  const before = JSON.stringify(frame);
  const token = bindSyntheticEpochFence(frame);
  assert.deepEqual(Object.keys(token).sort(), ["revision", "schema", "toy_epoch"]);
  assert.equal(token.schema, "fictional_dependency_epoch_fence_v1");
  assert.equal(token.toy_epoch, 1);
  const checked = recheckSyntheticEpochFence(frame, token);
  assert.equal(checked.fence_status, "toy_fence_matches_no_release");
  assert.equal(checked.toy_binding_matches_current, true);
  assert.equal(checked.data_release_authorized, false);
  assert.equal(checked.actual_compare_and_swap_performed, false);
  assert.equal(checked.real_monotonic_epoch_authenticated, false);
  assert.equal(checked.actual_witness_contacted, false);
  assert.equal(checked.actual_invalidation_performed, 0);
  assert.equal(checked.actual_deletions_performed, 0);
  assert.equal(checked.actual_replay_performed, false);
  assert.equal(checked.real_import_enabled, false);
  assert.equal(checked.any_hash_disclosed, false);
  assert.equal(JSON.stringify(frame), before);
  assert.ok(!JSON.stringify(checked).includes(token.revision.toy_graph_digest));
});

test("actual fictional A to B to A data transition rejects ABA with advanced toy epoch", () => {
  const originalA = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 6);
  const initial = JSON.stringify(originalA);
  const token = bindSyntheticEpochFence(originalA);
  // B: update a legitimate restore cursor, not merely the toy epoch.
  const intermediateB = structuredClone(originalA);
  intermediateB.toy_epoch = 7;
  intermediateB.restore_state.snapshot = {
    applied_sequence: 1, applied_digest: originalA.restore_state.registry[0].digest,
  };
  assert.notDeepEqual(intermediateB.restore_state, originalA.restore_state);
  assert.equal(previewSyntheticRestorePreflight(intermediateB.restore_state).preflight_status,
    "requires_replay_and_revalidation", "B must independently pass the toy preflight");
  assert.equal(recheckSyntheticEpochFence(intermediateB,
    bindSyntheticEpochFence(intermediateB)).fence_status,
  "toy_fence_matches_no_release");
  assert.equal(recheckSyntheticEpochFence(intermediateB, token).fence_status,
    "stale_toy_epoch_or_revision");

  // A again: restore the EXACT original source/graph metadata, but at epoch 8.
  const returnedA = structuredClone(originalA);
  returnedA.toy_epoch = 8;
  assert.deepEqual(returnedA.restore_state, originalA.restore_state);
  assert.deepEqual(returnedA.graph, originalA.graph);
  assert.ok(originalA.toy_epoch < intermediateB.toy_epoch &&
    intermediateB.toy_epoch < returnedA.toy_epoch);
  assert.equal(recheckSyntheticDerivativeRevision(returnedA.restore_state, returnedA.graph,
    token.revision).revision_status, "toy_revision_matches_no_release");
  assert.equal(recheckSyntheticEpochFence(returnedA, token).fence_status,
    "stale_toy_epoch_or_revision");
  const window = rehearseSyntheticFenceWindow(originalA, returnedA, token);
  assert.equal(window.window_status, "would_abort_at_final_check");
  assert.equal(window.first_check, "toy_fence_matches_no_release");
  assert.equal(window.final_check, "stale_toy_epoch_or_revision");
  assert.equal(window.data_release_authorized, false);
  assert.equal(window.actual_compare_and_swap_performed, false);
  assert.equal(JSON.stringify(originalA), initial);
});

test("actual fictional A to B to A is undetectable if the caller also rolls epoch back", () => {
  const originalA = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 6);
  const token = bindSyntheticEpochFence(originalA);
  const intermediateB = structuredClone(originalA);
  intermediateB.toy_epoch = 7;
  intermediateB.restore_state.snapshot = {
    applied_sequence: 1, applied_digest: originalA.restore_state.registry[0].digest,
  };
  assert.notDeepEqual(intermediateB.restore_state.snapshot, originalA.restore_state.snapshot);
  assert.equal(recheckSyntheticEpochFence(intermediateB,
    bindSyntheticEpochFence(intermediateB)).fence_status, "toy_fence_matches_no_release");
  // Return both original content AND original counter: an unauthenticated
  // caller-controlled epoch cannot prove B ever existed.
  const rolledBackA = structuredClone(originalA);
  assert.equal(rolledBackA.toy_epoch, 6);
  assert.deepEqual(rolledBackA.restore_state, originalA.restore_state);
  const report = rehearseSyntheticFenceWindow(originalA, rolledBackA, token);
  assert.equal(report.window_status, "toy_checks_match_no_commit");
  assert.equal(report.final_check, "toy_fence_matches_no_release");
  assert.equal(report.real_monotonic_epoch_authenticated, false);
  assert.equal(report.actual_compare_and_swap_performed, false);
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.real_import_enabled, false);
});

test("toy fence recognizes stale graph or restore revision even without epoch advance", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 4);
  const token = bindSyntheticEpochFence(frame);
  const newer = structuredClone(frame);
  newer.restore_state.snapshot = {
    applied_sequence: 1, applied_digest: newer.restore_state.registry[0].digest,
  };
  assert.equal(recheckSyntheticEpochFence(newer, token).fence_status,
    "stale_toy_epoch_or_revision");
  assert.equal(rehearseSyntheticFenceWindow(frame, newer, token).window_status,
    "would_abort_at_final_check");
  const incomplete = structuredClone(frame);
  incomplete.graph.artifacts.pop();
  assert.equal(recheckSyntheticEpochFence(incomplete, token).fence_status,
    "blocked_by_current_preflight_or_coverage");
});

test("unverified witness or damaged registry blocks fictional final stage", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 2);
  const token = bindSyntheticEpochFence(frame);
  const invalid = structuredClone(frame);
  invalid.restore_state.registry[0].action = "revoke_import_consent";
  const unavailable = structuredClone(frame);
  unavailable.restore_state.witness = null;
  for (const changed of [invalid, unavailable]) {
    const report = rehearseSyntheticFenceWindow(frame, changed, token);
    assert.equal(report.window_status, "would_abort_at_final_check");
    assert.equal(report.first_check, "toy_fence_matches_no_release");
    assert.equal(report.final_check, "blocked_by_current_preflight_or_coverage");
    assert.equal(report.source_or_graph_details_disclosed, false);
    assert.equal(report.actual_compare_and_swap_performed, false);
    assert.equal(report.data_release_authorized, false);
    assert.ok(!JSON.stringify(report).includes("fictional-source"));
  }
});

test("early stale toy check short-circuits without inspecting later input", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 2);
  const token = bindSyntheticEpochFence(frame);
  const wrong = { ...frame, toy_epoch: 3 };
  const result = rehearseSyntheticFenceWindow(wrong,
    { arbitrary_private_data: "should not be examined" }, token);
  assert.equal(result.window_status, "would_abort_at_first_check");
  assert.equal(result.first_check, "stale_toy_epoch_or_revision");
  assert.equal(result.final_check, "not_evaluated");
  assert.equal(result.data_release_authorized, false);
});

test("fictional epoch fence rejects rollback and malformed epoch types", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 5);
  const token = bindSyntheticEpochFence(frame);
  const rolledBack = { ...frame, toy_epoch: 4 };
  const result = rehearseSyntheticFenceWindow(frame, rolledBack, token);
  assert.equal(result.window_status, "would_abort_epoch_rollback");
  assert.equal(result.final_check, "stale_toy_epoch_or_revision");
  for (const bad of [-1, 1.5, Infinity, NaN, "5", new Number(5),
    Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => makeSyntheticEpochFenceFixture(frame.restore_state, bad),
      /Synthetic epoch fence:/);
    assert.throws(() => bindSyntheticEpochFence({ ...frame, toy_epoch: bad }),
      /Synthetic epoch fence:/);
    assert.throws(() => recheckSyntheticEpochFence({ ...frame, toy_epoch: bad }, token),
      /Synthetic epoch fence:/);
  }
});

test("fictional epoch binding is typed, exact and rejects forged fields", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 1);
  const token = bindSyntheticEpochFence(frame);
  for (const bad of [
    null, undefined, false, [], {}, "valid",
    { ...token, extra: "private" },
    { ...token, schema: "wrong" },
    { ...token, schema: ["fictional_dependency_epoch_fence_v1"] },
    { ...token, toy_epoch: "1" },
    { ...token, revision: { ...token.revision, extra: true } },
    { ...token, revision: { ...token.revision, toy_graph_digest: ["a".repeat(64)] } },
    { ...token, revision: { ...token.revision, schema: "v2" } },
  ]) assert.throws(() => recheckSyntheticEpochFence(frame, bad),
    /Synthetic epoch fence: malformed fictional fence binding/);
  const forged = { ...token, revision: {
    ...token.revision, toy_graph_digest: "f".repeat(64),
  }};
  assert.equal(recheckSyntheticEpochFence(frame, forged).fence_status,
    "stale_toy_epoch_or_revision");
});

test("graph reorder preserves toy epoch consistency but cannot commit data", () => {
  const frame = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 7);
  const token = bindSyntheticEpochFence(frame);
  const reorder = structuredClone(frame);
  reorder.graph.claims.reverse();
  reorder.graph.artifacts.reverse();
  for (const claim of reorder.graph.claims) claim.evidence.reverse();
  for (const artifact of reorder.graph.artifacts) artifact.depends_on.reverse();
  const report = rehearseSyntheticFenceWindow(frame, reorder, token);
  assert.equal(report.window_status, "toy_checks_match_no_commit");
  assert.equal(report.actual_compare_and_swap_performed, false);
  assert.equal(report.data_release_authorized, false);
  assert.equal(report.real_monotonic_epoch_authenticated, false);
});

test("toy epoch CLI is deterministic, no-argument, no-write, and status-only", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki-synthetic/epoch-fence-rehearsal-cli.mjs", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-epoch-"));
  const run = (args, zone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", env: { ...process.env, TMPDIR: root, TZ: zone },
  });
  try {
    const utc = run([], "UTC"), prague = run([], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(prague.status, 0, prague.stderr);
    assert.equal(utc.stdout, prague.stdout);
    const obj = JSON.parse(utc.stdout);
    assert.equal(obj.unchanged_check_window, "toy_checks_match_no_commit");
    assert.equal(obj.aba_intermediate_b_validated, "toy_fence_matches_no_release");
    assert.equal(obj.aba_original_binding_stale_at_b, "stale_toy_epoch_or_revision");
    assert.equal(obj.aba_a_to_b_to_a_with_advanced_epoch, "would_abort_at_final_check");
    assert.equal(obj.aba_epoch_rollback_undetectable_in_toy, "toy_checks_match_no_commit");
    assert.equal(obj.stale_first_check, "would_abort_at_first_check");
    assert.equal(obj.witness_missing_at_final_check, "would_abort_at_final_check");
    assert.equal(obj.changed_snapshot_at_final_check, "would_abort_at_final_check");
    assert.equal(obj.actual_compare_and_swap_performed, false);
    assert.equal(obj.data_release_authorized, false);
    assert.equal(obj.real_import_enabled, false);
    for (const forbidden of ["fictional-source", "fictional-claim",
      "toy_graph_digest", "toy_restore_digest", "applied_digest", "previous_digest"]) {
      assert.ok(!utc.stdout.includes(forbidden), forbidden);
    }
    const refused = run(["../../real-archive.json"], "UTC");
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, "");
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
