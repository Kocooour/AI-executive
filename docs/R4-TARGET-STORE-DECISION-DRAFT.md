# R4 — production target-store location and backup decision DRAFT

**Decision requested, not made.** Issue #408 prepares the evidence for owner approval; it does not activate production target mode or replace legacy storage. No existing runtime setting, route, bootstrap routine or deployment script is changed here.

## Naming and isolation proposal

- Proposed human/operator designation: **Lumi personal-v1 production target store**.
- Proposed canonical directory (example; must be confirmed for the actual service account and mount layout): `/var/lib/ai-executive-target/personal-v1`, containing `lumi-target.sqlite` plus its sidecar journal and witness material. This is deliberately **outside** `AI_EXECUTIVE_DATA_DIR` (typically `/var/lib/ai-executive`), not a subdirectory, symlink or alias of the legacy store.
- Future operator-facing configuration should use one explicitly documented production-store path, rather than silently treating the currently named `AI_EXECUTIVE_TARGET_STAGING_DIRECTORY` as a production migration flag. One option is a future `AI_EXECUTIVE_TARGET_STORE_DIRECTORY` selection verified before boot; **not implemented or read today**. The existing runtime reads `AI_EXECUTIVE_TARGET_STAGING_DIRECTORY`; do not rename it during #408.
- On a **new** path only, a separately approved operator step would invoke `bootstrapIsolatedTargetStore({ stagingDirectory, ownerUserId })`, first verifying that the parent exists and the destination **does not exist**. The bootstrap creates an isolated schema, owner, personal workspace, private system Area, target database, journal/witness and new restore generation; it must never be pointed at the legacy data directory or used as an in-place upgrade.
- Restrict the directory and archival copy to the dedicated service account, with file/directory permissions appropriate to sensitive auth state. The production startup must fail closed when the path, identity, restore generation or journal/witness integrity is inconsistent.

## Required operator settings from `TARGET_PERSONAL_V1_REQUIRED_SETTINGS`

| Environment variable (exact) | Required value and verification |
| --- | --- |
| `AI_EXECUTIVE_TARGET_STAGING_DIRECTORY` | Absolute canonical isolated target directory. It must not overlap the legacy data directory or any earlier staging instance. |
| `AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID` | The authenticated **single owner** identity that maps to the target store owner. Must match the bootstrap and verified session, never inferred from client input. |
| `AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION` | The UUID of that **specific** target store's current restore generation. Refresh after a documented and verified target restore; never reuse a stale value. |

These are non-boolean settings, separate from the 31 default-off boolean flags in `TARGET_PERSONAL_V1_PROFILE`. This document authorizes **none** of the flags. Confirm additional owner-auth and deployment requirements (including #402 provisioning) in the release plan before activation.

## Archival backup and rehearsal coverage

A complete recovery unit must include all files required to restore both the legacy and the target data/security domains:

1. A consistent **legacy** `store.sqlite` snapshot with its WAL state, any legacy `store.json`, application backup artifacts, and separate passkey, push, connector and token state. The app's format-v2 cleaned backup is narrower and excludes or clears some credential/cache tables by design.
2. A consistent **target** `lumi-target.sqlite` snapshot **and** the append-only `lumi-target.journal`, anti-rollback witness and any other security/restore-generation companion files. Preserve the exact pairing; replacing only target SQLite can intentionally put the store into `restore_pending`.
3. A manifest of all archive files with names, sizes and cryptographic hashes, plus schema versions, exact source SHA, permissions/ownership and recovery procedure. Hashes belong to operator-only evidence, not publicly posted with user content.
4. An isolated rehearsal restoring the complete copy into a **new empty** destination, checking every table's count and content hash plus SQLite integrity. The target journal and witness must be checked with the supported target preflight/restore mechanism; **table equality alone does not prove its anti-rollback correctness**.

No tool introduced by #408 may read/write a production path on behalf of an agent. Before cutover, an operator must separately demonstrate the same backup/restore controls on an authorized consistent snapshot, then explicitly approve each production change and rollback scope as in [R4 cutover runbook](R4-CUTOVER-RUNBOOK.md).

## Open decisions / no code switch

- Confirm canonical directory and ownership; whether an explicit production variable is added in a future, separately reviewed PR.
- Confirm backup consistency/quiescence and retention/security policy for the target journal and witness across filesystems.
- Verify #388 BFCache and #402 owner-session provisioning before any production change.
- Review the chosen rollback authority and client refresh procedure; the legacy IndexedDB copy cannot be wiped remotely.

**Nothing in this draft constitutes cutover approval.**
