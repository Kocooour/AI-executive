import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TARGET_PERSONAL_V1_BUILD_ENV } from "../lib/target-personal-profile.ts";

const repo = path.resolve(import.meta.dirname, "..");
const sha = "e".repeat(40);

function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lumi-build-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "lib", "bin", ".next"]) {
    mkdirSync(path.join(root, dir));
  }
  for (const file of ["scripts/target-build-profile.mjs", "lib/target-personal-profile.ts"])
    copyFileSync(path.join(repo, file), path.join(root, file));
  const pnpm = path.join(root, "bin/pnpm");
  writeFileSync(pnpm, `#!/bin/sh
test "$1" = build || exit 1
printf '%s' "\${NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW-unset}" > "$LUMI_CAPTURE"
printf '%s' "\${NEXT_PUBLIC_LUMI_E2E_QUEUE_WITNESS-unset}" > "$LUMI_CAPTURE.e2e"
printf '%s' "$LUMI_BUILD_ID" > .next/BUILD_ID
`);
  const git = path.join(root, "bin/git");
  writeFileSync(git, `#!/bin/sh
test "$1" = rev-parse && test "$2" = HEAD || exit 1
printf '%s\\n' "$LUMI_SHA"
`);
  chmodSync(pnpm, 0o755);
  chmodSync(git, 0o755);
  const capture = path.join(root, "capture");
  const env = {
    ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
    LUMI_CAPTURE: capture, LUMI_BUILD_ID: "synthetic-build", LUMI_SHA: sha,
    NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW: "operator-forged",
    NEXT_PUBLIC_LUMI_E2E_QUEUE_WITNESS: "1",
  };
  function call(action, profile) {
    return spawnSync(process.execPath, [
      path.join(root, "scripts/target-build-profile.mjs"), action, profile, root,
    ], { env, encoding: "utf8" });
  }
  return { root, capture, call };
}

test("personal-v1 selects the one canonical build flag and verifies its manifest", t => {
  const { root, capture, call } = sandbox(t);
  assert.deepEqual(TARGET_PERSONAL_V1_BUILD_ENV, {
    NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW: "1",
  });
  const built = call("--build", "personal-v1");
  assert.equal(built.status, 0, built.stderr);
  assert.equal(readFileSync(capture, "utf8"), "1");
  const manifest = JSON.parse(readFileSync(path.join(root, ".next/lumi-build-profile.json"), "utf8"));
  assert.equal(manifest.profile, "personal-v1");
  assert.deepEqual(manifest.buildEnv, TARGET_PERSONAL_V1_BUILD_ENV);
  assert.equal(manifest.sourceSha, sha);
  assert.equal(call("--check", "personal-v1").status, 0);
  assert.notEqual(call("--check", "off").status, 0, "profile drift must be caught");
  writeFileSync(path.join(root, ".next/BUILD_ID"), "unexpected");
  assert.notEqual(call("--check", "personal-v1").status, 0, "build ID drift must be caught");
});

test("off build erases inherited preview flag and cannot validate as personal-v1", t => {
  const { root, capture, call } = sandbox(t);
  const built = call("--build", "off");
  assert.equal(built.status, 0, built.stderr);
  assert.equal(readFileSync(capture, "utf8"), "unset");
  const manifest = JSON.parse(readFileSync(path.join(root, ".next/lumi-build-profile.json"), "utf8"));
  assert.deepEqual(manifest.buildEnv, {});
  assert.equal(call("--check", "off").status, 0);
  assert.notEqual(call("--check", "personal-v1").status, 0);
});

test("a checkout dotenv cannot silently override the off shell", t => {
  const { root, capture, call } = sandbox(t);
  writeFileSync(path.join(root, ".env.production.local"),
    "NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1\\n");
  const result = call("--build", "off");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dotenv attempts to control/);
  assert.throws(() => readFileSync(capture, "utf8"), { code: "ENOENT" });
});

test("an inherited E2E-only public flag never reaches a production build", t => {
  const { capture, call } = sandbox(t);
  for (const profile of ["off", "personal-v1"]) {
    const built = call("--build", profile);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(readFileSync(capture + ".e2e", "utf8"), "unset", profile);
  }
});

test("a checkout dotenv cannot inject any Lumi public build flag", t => {
  const { root, capture, call } = sandbox(t);
  for (const line of ["NEXT_PUBLIC_LUMI_E2E_QUEUE_WITNESS=1",
    "export NEXT_PUBLIC_LUMI_E2E_QUEUE_WITNESS = 1", "NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW: 1"]) {
    writeFileSync(path.join(root, ".env.local"), line + "\n");
    const result = call("--build", "personal-v1");
    assert.notEqual(result.status, 0, line);
    assert.match(result.stderr, /dotenv attempts to control/, line);
    assert.throws(() => readFileSync(capture, "utf8"), { code: "ENOENT" }, line);
  }
});

test("target capture remains gated by the compiled v1 shell, not profile flags alone", () => {
  const root = readFileSync(path.join(repo, "app/ui/lumi-app-root.tsx"), "utf8");
  const navigation = readFileSync(path.join(repo, "app/ui/navigation.ts"), "utf8");
  assert.match(navigation,
    /mobileDesignV1Preview = process\.env\.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW === "1"/);
  assert.match(root, /const targetCapture=Boolean\([\s\S]*?targetPrivateNoteCreate&&mobileDesignV1Preview\)/);
  assert.match(root, /v1Shell: mobileDesignV1Preview/);
});
