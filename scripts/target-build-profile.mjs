#!/usr/bin/env node
// C29: exact-profile Next builds. Never inherit the v1 switch from an operator.
// This script is invoked by the reviewed deploy and verified again before start.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TARGET_PERSONAL_V1_BUILD_ENV } from "../lib/target-personal-profile.ts";

const [action, profile, app] = process.argv.slice(2);
if (!["--build", "--check"].includes(action) ||
    !["off", "personal-v1"].includes(profile) ||
    !app || !path.isAbsolute(app) || path.normalize(app) !== app) {
  throw new Error("usage: target-build-profile.mjs --build|--check off|personal-v1 /absolute/app");
}

const manifestPath = path.join(app, ".next", "lumi-build-profile.json");
const buildIdPath = path.join(app, ".next", "BUILD_ID");
const expectedEnv = profile === "personal-v1" ? TARGET_PERSONAL_V1_BUILD_ENV : {};
const sourceSha = () => execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const buildId = () => readFileSync(buildIdPath, "utf8").trim();

function checkBuild() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schema, 1, "unknown Lumi build manifest schema");
  assert.equal(manifest.profile, profile, "build profile does not match validated runtime profile");
  assert.deepEqual(manifest.buildEnv, expectedEnv, "v1 shell build environment drift");
  assert.equal(manifest.buildId, buildId(), "Next BUILD_ID does not match build manifest");
  assert.equal(manifest.sourceSha, sourceSha(), "build manifest does not match checkout SHA");
  assert.match(manifest.sourceSha, /^[0-9a-f]{40}$/);
  assert.ok(manifest.buildId.length > 0, "missing Next build ID");
}

if (action === "--build") {
  // Next automatically reads local dotenv files even with an explicit process env.
  // Refuse a conflicting local build flag, rather than letting .env override off.
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const file = path.join(app, name);
    if (existsSync(file) &&
        /^\s*(?:export\s+)?NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW\s*=/m
          .test(readFileSync(file, "utf8"))) {
      throw new Error("checkout dotenv attempts to control the compile-time v1 shell");
    }
  }
  const childEnv = { ...process.env };
  delete childEnv.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW;
  Object.assign(childEnv, expectedEnv);
  const result = spawnSync("pnpm", ["build"], { cwd: app, env: childEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Next build failed");
  const manifest = {
    schema: 1, profile, buildEnv: expectedEnv, buildId: buildId(), sourceSha: sourceSha(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o644 });
}
checkBuild();
