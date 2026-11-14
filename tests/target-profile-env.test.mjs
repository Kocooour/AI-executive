import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TARGET_PERSONAL_V1_PROFILE, TARGET_PERSONAL_V1_EXCLUDED,
  TARGET_PERSONAL_V1_REQUIRED_SETTINGS, targetPersonalV1Env,
} from "../lib/target-personal-profile.ts";

const cli = path.resolve("scripts/target-profile-env.mjs");
const settings = TARGET_PERSONAL_V1_REQUIRED_SETTINGS.map(item => item.name);
const generation = "2a10b529-66a4-4790-a600-a27f2d996a0f";
const values = ["/tmp/isolated-target", "owner-01", generation];
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const block = (enabled = targetPersonalV1Env()) => [
  ...Object.entries(enabled).map(([key, value]) => key + "=" + value),
  ...settings.map((name, i) => name + "=" + values[i]),
].join("\n") + "\n";

function withEnv(content, verify) {
  const dir = mkdtempSync(path.join(tmpdir(), "lumi-profile-test-"));
  const filename = path.join(dir, "operator.env");
  try {
    writeFileSync(filename, content, { mode: 0o600 });
    return verify(filename);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("generated profile exactly tracks targetPersonalV1Env plus all three blank operator settings", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const expected = targetPersonalV1Env();
  const lines = result.stdout.trim().split("\n").filter(line => !line.startsWith("#"));
  assert.deepEqual(lines, [
    ...Object.entries(expected).map(([name, value]) => name + "=" + value),
    ...settings.map(name => name + "="),
  ]);
  assert.deepEqual(Object.keys(expected), [...TARGET_PERSONAL_V1_PROFILE],
    "additions to the TypeScript profile must be reflected by the CLI");
});

test("off: no target flags, even with unrelated legacy variables", () => {
  withEnv("AI_EXECUTIVE_SESSION_SECRET=never-print-me\nLEGACY_VALUE=1\n", file => {
    const result = run("--check", file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "off\n");
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-me/);
  });
});

test("personal-v1: exactly the imported flags and valid non-secret operator settings", () => {
  withEnv("# operator config\n" + block() + "UNRELATED_SECRET=never-print-me\n", file => {
    const result = run("--check", file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "personal-v1\n");
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-me|owner-01|isolated-target|2a10b529/);
    for (let i = 0; i < settings.length; i++) {
      const setting = run("--setting", file, settings[i]);
      assert.equal(setting.status, 0);
      assert.equal(setting.stdout, values[i] + "\n");
    }
  });
});

test("partial profile fails closed before activation and reveals names, never values", () => {
  const first = TARGET_PERSONAL_V1_PROFILE[0];
  withEnv(first + "=true\n" + settings[0] + "=/private/sensitive/path\n" +
    settings[1] + "=private-user-123\n" + settings[2] + "=very-private-generation\n", file => {
    const result = run("--check", file);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "invalid\n");
    assert.match(result.stderr, /check names:/);
    assert.ok(result.stderr.includes(TARGET_PERSONAL_V1_PROFILE[1]));
    assert.ok(result.stderr.includes(settings[2]));
    assert.doesNotMatch(result.stderr, /private\/sensitive|private-user-123|very-private-generation/);
    const setting = run("--setting", file, settings[0]);
    assert.notEqual(setting.status, 0);
    assert.doesNotMatch(setting.stdout + setting.stderr, /private\/sensitive/);
  });
});

test("excluded and unknown enabled flags are both rejected", () => {
  const excluded = TARGET_PERSONAL_V1_EXCLUDED[0].flag;
  const extra = "AI_EXECUTIVE_TARGET_UNREVIEWED_ENABLED";
  for (const flag of [excluded, extra]) {
    withEnv(block() + flag + "=true\n", file => {
      const result = run("--check", file);
      assert.equal(result.stdout, "invalid\n");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(flag));
    });
  }
});

test("invalid, duplicated, malformed and empty profile settings do not leak values", () => {
  const cases = [
    block().replace(settings[2] + "=" + generation, settings[2] + "=not-a-uuid"),
    block().replace(settings[1] + "=owner-01", settings[1] + "="),
    block() + TARGET_PERSONAL_V1_PROFILE[0] + "=false\n",
    block() + settings[0] + "=/private/secret/duplicate\n",
    block().replace(TARGET_PERSONAL_V1_PROFILE[0] + "=true", TARGET_PERSONAL_V1_PROFILE[0] + "=unsafe"),
    block().replace(TARGET_PERSONAL_V1_PROFILE[0] + "=true", TARGET_PERSONAL_V1_PROFILE[0] + "=true # not a systemd comment"),
  ];
  for (const input of cases) withEnv(input, file => {
    const result = run("--check", file);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "invalid\n");
    assert.doesNotMatch(result.stdout + result.stderr, /not-a-uuid|private\/secret|owner-01|2a10b529/);
  });
});

test("unknown flag with value false leaves the target disabled", () => {
  withEnv("AI_EXECUTIVE_TARGET_UNREVIEWED_ENABLED=false\n", file => {
    const result = run("--check", file);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "off\n");
  });
});

test("unreadable target configuration returns invalid without printing the path", () => {
  const sensitivePath = "/does-not-exist/private-target-secret.env";
  const result = run("--check", sensitivePath);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "invalid\n");
  assert.doesNotMatch(result.stderr, /private-target-secret/);
});
