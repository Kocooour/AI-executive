// Test-only fixture: existing HTTP tests mint synthetic owner cookies directly.
// Production never auto-initializes a missing cutoff; these synthetic fixtures
// explicitly provision their isolated data directories before issuing tokens.
// Security tests of missing/corrupt state import lib/auth.ts directly instead.
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "../../lib/data-dir.ts";
import { initializeOwnerSessionRevocationState } from "../../lib/owner-session-revocation.ts";
import { createSessionToken as createRealSessionToken } from "../../lib/auth.ts";

export * from "../../lib/auth.ts";

export function createSessionToken(...args) {
  const state = path.join(resolveDataDirectory(), "owner-session-valid-from.sqlite");
  if (!existsSync(state)) {
    // Concurrent synthetic test workers may race on their shared default data
    // directory. Only one initializer creates the file; never overwrite it.
    try { initializeOwnerSessionRevocationState(); }
    catch (error) { if (!existsSync(state)) throw error; }
  }
  // Await any in-progress initialization through the real fail-closed issuer.
  // Tests should not attempt to repair a corrupt state file.
  return createRealSessionToken(...args);
}
