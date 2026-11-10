import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  H1_REAL_GATE_SCHEMA,
  HumanWikiH1RealEntryBlockedError,
  denyHumanWikiH1RealImport,
  humanWikiH1RealEntryReadiness,
} from "../lib/humanwiki-h1-real-entry.mjs";

test("HumanWiki H1-real intake remains default denied with six explicit release blockers", () => {
  const report = humanWikiH1RealEntryReadiness();
  assert.equal(report.schema, H1_REAL_GATE_SCHEMA);
  assert.equal(report.result, "blocked_not_enabled");
  assert.equal(report.enabled, false);
  assert.deepEqual(report.source_types_in_future_scope,
    ["chatgpt_user_export", "claude_user_export"]);
  assert.equal(report.mail_content_import_in_scope, false);
  assert.equal(report.explicit_owner_consent_received, false);
  assert.equal(report.real_actor_or_area_verified, false);
  assert.equal(report.independent_witness_verified, false);
  assert.equal(report.real_data_accepted, false);
  assert.equal(report.real_data_read, false);
  assert.equal(report.data_stored, false);
  assert.equal(report.external_model_egress, false);
  assert.equal(report.claims_created, 0);
  assert.equal(report.tasks_created, 0);
  assert.deepEqual(report.prerequisites.map(x => x.code), [
    "authenticated_actor_and_owner_private_area_acl",
    "source_specific_consent_and_quarantine_retention",
    "speaker_provenance_sensitivity_and_human_review",
    "independent_durable_revocation_and_rollback_witness",
    "atomic_commit_and_derivative_release_invalidation",
    "r3_integration_r4_owner_release_and_full_e2e",
  ]);
  assert.ok(report.prerequisites.every(x =>
    x.status === "not_verified_blocked" &&
    typeof x.requirement === "string" && x.requirement.length > 0));
  assert.deepEqual(humanWikiH1RealEntryReadiness(), report);
});

test("HumanWiki H1-real rejector does not read untrusted request or consent claims", () => {
  let accesses = 0;
  const hostile = new Proxy({}, {
    get() { accesses++; throw Error("request body leaked into preflight"); },
    getPrototypeOf() { accesses++; throw Error("request prototype read"); },
    ownKeys() { accesses++; throw Error("request keys enumerated"); },
    getOwnPropertyDescriptor() { accesses++; throw Error("request descriptor read"); },
  });
  for (const candidate of [
    undefined, null, {}, [], hostile, "ChatGPT export plaintext",
  ]) {
    assert.throws(() => denyHumanWikiH1RealImport(candidate, hostile), err =>
      err instanceof HumanWikiH1RealEntryBlockedError &&
      err.code === "HUMANWIKI_H1_REAL_IMPORT_BLOCKED" &&
      err.message === "HumanWiki H1-real import is not enabled or authorized");
  }
  assert.equal(accesses, 0, "preflight must refuse before inspecting any content, metadata or claim");
});

test("HumanWiki H1-real cannot be unlocked by feature flags or caller-supplied credentials", () => {
  const oldValue = process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
  try {
    for (const flag of ["true", "1", "enabled", "false", ""]) {
      process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED = flag;
      const readiness = humanWikiH1RealEntryReadiness();
      assert.equal(readiness.result, "blocked_not_enabled");
      assert.equal(readiness.enabled, false);
      assert.throws(() => denyHumanWikiH1RealImport({
        source: "gmail",
        ownerPrivate: true,
        explicitConsent: true,
        claimsReviewed: true,
        encrypted: true,
        verified: true,
      }, {
        actorAuthenticated: true,
        areaAllowed: true,
        independentWitness: true,
        r4Approved: true,
      }), HumanWikiH1RealEntryBlockedError);
    }
  } finally {
    if (oldValue === undefined) delete process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
    else process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED = oldValue;
  }
});

test("HumanWiki H1-real status CLI is deterministic, argument-free and never reads an export", () => {
  const cli = fileURLToPath(new URL("../scripts/humanwiki/h1-real-entry-cli.mjs", import.meta.url));
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumi-humanwiki-h1-entry-"));
  const run = (args, timezone) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env, TZ: timezone, TMPDIR: dir,
      AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED: "true",
    },
  });
  try {
    const utc = run([], "UTC"), local = run([], "Europe/Prague");
    assert.equal(utc.status, 0, utc.stderr);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(utc.stdout, local.stdout);
    assert.deepEqual(JSON.parse(utc.stdout), humanWikiH1RealEntryReadiness());
    const invalid = run(["/tmp/real-export.json"], "UTC");
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, "");
    assert.ok(invalid.stderr.includes("Usage:"));
    assert.deepEqual(readdirSync(dir), [], "no uploaded bytes or temporary content");
    for (const forbidden of [
      "real-export.json", "session_secret", "access_token", "email_body",
      "source_locator", "owner_id", "source_id", "consent_token",
    ]) assert.ok(!utc.stdout.includes(forbidden), forbidden);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
