# 2c, part 5 — fail-closed SQLite metadata preservation diagnostic

**Status: pure, read-only, caller-supplied before/after snapshots. No SQLite opening, writes, migration execution, feature activation, hold release, deployment, or attestation.** This builds on the canonical and side-table diagnostics in PRs #117–#120.

## Boundary and input

`checkLegacyAssigneeMetadataPreservation({ before, after, legacySharedWorkspaceIds })` requires each snapshot to carry all fields required by part 4 **plus** a complete `metadata` array, independent of `sideTables`:

```ts
metadata: [
  { key: "revision", value: "15" },
  { key: "updatedAt", value: "100" },
  { key: "restoreGeneration", value: "7" },
  { key: "vapidKeys", value: "<private; never log>" },
]
```

The real SQLite table has `key TEXT PRIMARY KEY, value TEXT NOT NULL` (see `applySchema` in `lib/server-store.ts`). Complete live snapshots must retain secret and future keys: the backup/export logic deliberately *filters* metadata to `revision` and `updatedAt`, so **backup/export snapshots are unsuitable for this check**. Data extraction, table completeness, transaction locking and provenance are outside this library.

The checker **rejects** missing/duplicate/extra keys on either side, additional row columns, non-string values, malformed JSON structures, getters/symbols/hidden properties, sparse arrays, and data that exceeds explicit bounds (4,096 rows per snapshot, key up to 256 characters, value up to 1,000,000 characters, 4,000,000 characters combined).

## Exact allowed metadata change policy

1. `revision` **must appear** in both metadata sets as a canonical, non-negative, safe-integer decimal string and equal the corresponding snapshot `revision`. Part 4 enforces that the after revision increments by exactly one when owner-assignee changes exist, otherwise remains unchanged.
2. `updatedAt` **must appear** in both metadata sets as the same canonical integer encoding. If an assignee changed, it may stay the same or advance; it may **not decrease**. For an exact no-op it must remain equal.
3. `restoreGeneration` may be absent in **both** sets, but then the canonical generation must be zero. If present, it must remain byte-for-byte identical and equal the snapshot `restoreGeneration`. Newly inserted, deleted or modified restore-generation rows are rejected.
4. **Every other key and value**, including VAPID secrets, unknown future keys, security/account tokens, and opaque JSON or ciphertext, must be byte-for-byte identical. No additions, deletions or rewrites are permitted. Row order is irrelevant.

The function re-runs the part-4 full canonical, relations/tombstones, legacy-selection and side-table preservation diagnostics against these same supplied snapshots. Returned results contain only revision/count aggregates; never keys, values, entity IDs or secrets. All `verifiedPersistedState`, `verifiedMetadata`, `verifiedSideTables`, `verifiedHomeTodayInbox`, `canApply`, `canReleaseHold`, `canActivateMyPlan` and `canEnableSharing` remain literally `false`. A successful diagnostic is **not** a statement of authoritative SQLite preservation.

## Still required for production

A future executor needs a separately reviewed authoritative SQLite snapshot/extractor (including lossless 64-bit INTEGER/BLOB handling and schema inventory), a trusted historical owner-only legacy designation, server-side Area/member ACL enforcement, a single transaction with compare-and-swap, side effect and trigger review, preserved offline clients and caches, crash-safe backup and rollback, deployment gates for 2a/2b, and an independent exact Home/Today/Inbox read-model preservation check. None of those gates is implemented here.

## Test coverage and isolation

`tests/legacy-assignee-metadata-postcheck.test.mjs` exercises legitimate migration and no-op pairs, malformed counters and timestamps, metadata additions/omissions/rewrites, restore-generation policy, secret preservation, duplicate keys, getters, cycles and bounded inputs, as well as inherited side-table and canonical failures.

Run the normal PR CI (`pnpm typecheck`, `pnpm test`, `pnpm build`, deployment-script syntax). Browser E2E remains **release-only**, before production deployment, on the exact final release commit. The work is limited to this GitHub branch and synthetic in-memory data; no live database, server, keys or personal data.
