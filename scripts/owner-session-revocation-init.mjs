// Explicit provisioning and validation. NEVER call --init during a routine restart.
// Run as the service user with AI_EXECUTIVE_DATA_DIR set to its real persistent directory.
// Usage: node --experimental-loader ./scripts/target-staging-ts-loader.mjs scripts/owner-session-revocation-init.mjs --init|--check
import {
  initializeOwnerSessionRevocationState,
  verifyOwnerSessionRevocationState,
} from "../lib/owner-session-revocation.ts";

const mode = process.argv[2];
if (process.argv.length !== 3 || (mode !== "--init" && mode !== "--check")) {
  console.error("Usage: owner-session-revocation-init.mjs --init|--check");
  process.exit(2);
}
try {
  if (mode === "--init") initializeOwnerSessionRevocationState();
  else verifyOwnerSessionRevocationState();
  console.log(mode === "--init"
    ? "Owner session revocation state initialized."
    : "Existing owner session revocation state verified.");
} catch {
  console.error("Owner session revocation state is missing, unsafe or unavailable.");
  process.exitCode = 1;
}
