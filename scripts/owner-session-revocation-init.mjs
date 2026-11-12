// Run once, as the app service account, before the first deployment of owner-cookie revocation.
// Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/owner-session-revocation-init.mjs
import { initializeOwnerSessionRevocationState } from "../lib/owner-session-revocation.ts";

try {
  initializeOwnerSessionRevocationState();
  console.log("Owner session revocation state initialized.");
} catch {
  console.error("Owner session revocation state already exists or cannot be safely initialized.");
  process.exitCode = 1;
}
