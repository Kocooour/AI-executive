/**
 * Operator-only CLI for the R2-ID.1 durable staging session store. Synthetic
 * test identities in an explicit, isolated staging directory ONLY; it never
 * touches the legacy/production store and is not reachable over HTTP.
 *
 *   node --experimental-loader ./scripts/target-staging-ts-loader.mjs \
 *     scripts/target-staging-session.mjs issue --directory /abs/stage \
 *       --generation <restore-generation-uuid> --user <userId> \
 *       [--lifetime-seconds 300] --synthetic-test-identity
 *   ... revoke      --directory ... --generation ... --session-id <uuid>
 *   ... revoke-user --directory ... --generation ... --user <userId>
 *
 * `issue` prints the raw session token exactly once on stdout (JSON); only its
 * SHA-256 hash is stored. Exit code 0 on success, 1 on any refusal.
 */
import path from "node:path";
import {
  issueDurableTargetStagingSession, revokeAllDurableTargetStagingSessionsForUser,
  revokeDurableTargetStagingSession,
} from "../lib/target-staging-durable-session.ts";

const VALUE_FLAGS = new Set(["directory", "generation", "user", "session-id", "lifetime-seconds"]);

function parse(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--synthetic-test-identity") {
      options.set("synthetic-test-identity", "true");
      continue;
    }
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!VALUE_FLAGS.has(name) || options.has(name) || rest[index + 1] === undefined) return null;
    options.set(name, rest[++index]);
  }
  return { command, options };
}

try {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) throw new Error("Invalid arguments");
  const { command, options } = parsed;
  const directory = options.get("directory");
  const generation = options.get("generation");
  if (!directory || !path.isAbsolute(directory) || !generation) throw new Error("Invalid arguments");
  const store = { stagingDirectory: directory, expectedRestoreGeneration: generation };
  let result;
  if (command === "issue") {
    if (options.get("synthetic-test-identity") !== "true" || !options.has("user")) {
      throw new Error("Issuing requires --user and --synthetic-test-identity");
    }
    const lifetime = options.has("lifetime-seconds") ? Number(options.get("lifetime-seconds")) : undefined;
    result = issueDurableTargetStagingSession(store, options.get("user"), lifetime);
  } else if (command === "revoke" && options.has("session-id")) {
    result = revokeDurableTargetStagingSession(store, options.get("session-id"));
  } else if (command === "revoke-user" && options.has("user")) {
    result = revokeAllDurableTargetStagingSessionsForUser(store, options.get("user"));
  } else {
    throw new Error("Unknown command");
  }
  process.stdout.write(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ ok: false, reason: "invalid_request" }));
  process.exitCode = 1;
}
