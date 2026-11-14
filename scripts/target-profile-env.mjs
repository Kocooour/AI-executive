#!/usr/bin/env node
// R4 C14: operator-only profile generator/checker. No application env mutation.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  TARGET_PERSONAL_V1_PROFILE, TARGET_PERSONAL_V1_EXCLUDED,
  TARGET_PERSONAL_V1_REQUIRED_SETTINGS, targetPersonalV1Env,
} from "../lib/target-personal-profile.ts";

const profile = new Set(TARGET_PERSONAL_V1_PROFILE);
const excluded = new Set(TARGET_PERSONAL_V1_EXCLUDED.map(item => item.flag));
const required = TARGET_PERSONAL_V1_REQUIRED_SETTINGS.map(item => item.name);
const prefix = TARGET_PERSONAL_V1_PROFILE[0].split("STAGING_")[0];
const isFlag = name => name.startsWith(prefix) && name.endsWith("_ENABLED");
const validOwner = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validGeneration = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function parseEnv(filename) {
  const values = new Map();
  const duplicate = new Set();
  const source = readFileSync(filename, "utf8");
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) {
      // A malformed target assignment cannot be silently treated as off.
      if (line.includes(prefix)) throw new Error("malformed target setting");
      continue;
    }
    const name = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // systemd EnvironmentFile does not treat inline # as a comment.
      // A boolean followed by "#..." must be invalid, not accepted as true.
      value = value.trim();
    }
    if (values.has(name) && (isFlag(name) || required.includes(name))) duplicate.add(name);
    values.set(name, value);
  }
  return { values, duplicate };
}

export function inspectProfile(values, duplicate = new Set()) {
  const enabled = [...values].filter(([name, value]) => isFlag(name) && value === "true")
    .map(([name]) => name);
  const malformed = [...values].filter(([name, value]) =>
    isFlag(name) && value !== "true" && value !== "false").map(([name]) => name);
  const missing = enabled.length
    ? TARGET_PERSONAL_V1_PROFILE.filter(name => values.get(name) !== "true")
    : [];
  const extra = enabled.filter(name => !profile.has(name) || excluded.has(name));
  const settings = enabled.length ? required.filter(name => {
    const value = values.get(name);
    if (!value || /[\x00-\x1f\x7f]/.test(value)) return true;
    if (name === required[0]) return !path.isAbsolute(value) || path.resolve(value) !== value;
    if (name === required[1]) return !validOwner.test(value);
    if (name === required[2]) return !validGeneration.test(value);
    return true;
  }) : [];
  const problems = [...new Set([...duplicate, ...malformed, ...missing, ...extra, ...settings])].sort();
  if (problems.length) return { status: "invalid", problems };
  return { status: enabled.length ? "personal-v1" : "off", problems: [] };
}

function fail() {
  process.stderr.write("target profile: invalid input (values suppressed)\n");
  process.exitCode = 2;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  const env = targetPersonalV1Env();
  process.stdout.write(["# Lumi personal-v1: enable only after separately approved cutover",
    ...Object.entries(env).map(([name, value]) => name + "=" + value),
    ...required.map(name => name + "="), ""].join("\n"));
} else if ((args.length === 2 && args[0] === "--check") ||
           (args.length === 3 && args[0] === "--setting")) {
  try {
    const { values, duplicate } = parseEnv(args[1]);
    const checked = inspectProfile(values, duplicate);
    if (args[0] === "--check") {
      process.stdout.write(checked.status + "\n");
      if (checked.status === "invalid") {
        process.stderr.write("target profile: invalid; check names: " + checked.problems.join(", ") + "\n");
        process.exitCode = 2;
      }
    } else if (checked.status !== "personal-v1" || !required.includes(args[2])) {
      fail();
    } else {
      // Only the three non-secret operator settings; never emitted by --check.
      process.stdout.write(values.get(args[2]) + "\n");
    }
  } catch {
    if (args[0] === "--check") process.stdout.write("invalid\n");
    fail();
  }
} else {
  process.stderr.write("usage: target-profile-env.mjs [--check env-file | --setting env-file setting-name]\n");
  process.exitCode = 2;
}
