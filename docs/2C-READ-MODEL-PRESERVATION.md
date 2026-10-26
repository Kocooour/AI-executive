# 2c, part 6 — Home / Today / Inbox preservation postcheck

**Status:** pure diagnostic of **caller-supplied** before/after results. No SQL read, live database, write, migration, deployment, recovery-hold release, Home/Today/Inbox implementation change, My Plan activation or sharing.

## Problem and scope

Part 5 checks the complete SQLite metadata table. A future owner-assignee backfill must also preserve the **actual Home, Today and Inbox read models**, not just underlying canonical entities or side tables.

`checkLegacyAssigneeReadModelPreservation({ before, after, legacySharedWorkspaceIds })` adds one more untrusted before/after comparison to the full checks from parts 1–5. Every snapshot carries an explicit `readModels` envelope:

```ts
readModels: {
  context: {
    actorUserId: "owner",
    asOf: "2026-10-26T11:00:00.000Z",
    timezone: "Europe/Prague",
    queryFingerprint: "version+filters+sort+visibility",
  },
  home: { /* complete ordered Home response */ },
  today: [ /* complete ordered Today response */ ],
  inbox: { /* complete ordered Inbox response */ },
}
```

The concrete read-model payloads are **opaque**: they may be arrays or plain objects, but must be complete, JSON-compatible ordered responses. Arrays are compared in order (presentation order matters); object-key order does not matter. Every nested value, identifier, count, flag, grouping and timestamp is compared. Missing/extra envelope fields, mutated context, getters, inherited or non-enumerable `readModels`, Proxy-wrapped values (including the input and snapshots), symbols, sparse arrays, unsupported values, unsafe integers, cycles and over-budget values fail closed. Snapshots must expose `readModels` as their own enumerable data property; no accessor or Proxy trap is invoked during read-model validation. Proxy detection uses Node.js `node:util` and this helper must run in a Node.js environment.

The `context` **must be byte-for-byte identical** before and after. A real extractor would need to derive it from the same authenticated actor, instant, timezone, visibility/ACL, route version, filters, sort and query configuration. `queryFingerprint` is caller-supplied text here, **not** cryptographic proof or independently verified provenance.

## Result and explicit non-authorizations

A successful result reports only the aggregate counts inherited from part 5 and `comparedReadModelCount: 3`. It must not include any read payload, actor ID, query fingerprint, entity ID, metadata key or sensitive value.

The flags `verifiedPersistedState`, `verifiedMetadata`, `verifiedSideTables`, `verifiedHomeTodayInbox`, `canApply`, `canReleaseHold`, `canActivateMyPlan` and `canEnableSharing` remain literally **false**. In particular, comparing two fabricated equal payloads is *not* proof that the actual app would render the same data.

Limits are shared across all six supplied view payloads: at most 8,000,000 canonical characters and 120,000 nodes; each view at most 2,000,000 characters; nesting depth at most 48; arrays and objects at most 20,000 members; strings at most 500,000 code units. The checker is a bounded in-memory comparator, not a database query.

## Production prerequisites remain separate

A separately reviewed executor must provide authenticated, transactionally consistent before/after snapshots, proof of complete SQLite schema/table coverage, server-side Area/member ACLs, a trusted historical legacy owner-only designation, lossless INTEGER/BLOB extraction, atomic write with CAS and rollback, trigger/side-effect review, offline-client and cache handling, plus exact **real** Home/Today/Inbox route readouts for an agreed matrix of actors and times. No such extractor, executor, attestation or release gate is added here.

Run the standard PR checks (`pnpm typecheck`, `pnpm test`, `pnpm build`, deployment script syntax). Browser E2E remains release-only, before deploying the exact final release commit.
