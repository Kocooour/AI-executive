# R4 — cutover runbook (PREPARATION ONLY)

**Status:** decision-support draft for issue #408 (stream C7), not approval or a production procedure to execute yet.
**Milestone:** B — R4 cutover preparation.
**Acceptance:** a content-free inventory and a passing archival-backup/restore-equality rehearsal on a *disposable, offline copy*, with negative tests. No agent operation on production.

## Immutable safety boundary

Neither this runbook nor any tool in #408 authorizes a production cutover, database/cache reset, migration, deletion, credential rotation, target flag activation, or replacement of persisted state. An agent **must not** run #408 tools against production. Only read-only observations of a pre-existing, independently captured **offline** copy and writes into **new, explicitly named, empty** output directories are in scope. Do not open the live SQLite file even for a "read-only" check: a SQLite connection may create or update WAL/SHM files. Keep copies of WAL with the main SQLite file; a bare copy of an active WAL-mode main file is not evidence of a consistent backup.

The old and target stores are distinct data domains. A backup of the legacy database (including the app's format-v2 owner-data export) is **not** a complete archival backup of credentials, passkeys, push subscriptions, integration secrets or target-store journal/witness state. Preserve the complete offline directory snapshot as the archive; treat app exports as additional, narrower recovery artifacts.

## Ordered evidence and gates

| Step | Human/operator action | Evidence required before proceeding |
| --- | --- | --- |
| 0 | Record intended deployment SHA and current production source/store locations **without printing secrets**; confirm the latest `main` and related PR heads. | Signed-off scope and exact SHA; no state mutation |
| 1 | Enumerate active browser tabs, installed PWAs and browsers on phones/desktops; coordinate with everyone who has a local copy. | Device/client inventory (manual checklist below), with acknowledgement per client |
| 2 | Confirm owner-session revocation from #402 is merged, explicitly provisioned and functional. | Init proof, successful owner logout/re-login, copied-cookie denial, clean CI |
| 3 | Resolve #388 BFCache lifecycle failures and demonstrate stale/returning clients cannot write old state. | Focused BFCache/restore-generation barrier evidence, exact test SHA |
| 4 | Capture a **consistent** archival snapshot while writers are quiesced or through an approved atomic filesystem/SQLite backup procedure. Preserve legacy DB + WAL, backups, credentials, integration state and, if present, target DB plus append-only journal and witness as one recovery unit. | Immutable archive identifier, restrictive permissions, file manifest/checksums, protected retention location |
| 5 | Run `scripts/cutover-inventory.mjs` on the offline copy, giving a new output location. Review only aggregated counts, timestamp ranges and boolean presence. | Content-free JSON, short summary, secret-content rejection tests |
| 6 | Run the copy-only rehearsal in `deployment/rehearsal/` using a new empty output location. Check copied files, table rows, SHA-256 digests and SQLite `integrity_check` plus tamper/missing-table/non-empty-destination negative tests. **One-source copy fidelity is not independent backup verification.** | Private backup manifest and scoped copy-fidelity report; optional comparison of two separate input paths; independent capture still requires external evidence |
| 7 | Confirm the proposed target production store location and settings in [R4 target decision draft](R4-TARGET-STORE-DECISION-DRAFT.md); verify its own journal/witness/restore-generation plan and archival recovery, without implementing the switchover. | Owner-reviewed configuration proposal; no target flags enabled |
| 8 | Run typecheck, relevant unit/integration tests, production build and `PR Checks`; resolve all review findings. | Green PR checks and clean full-diff review on current head |
| 9 | After the intended release commits are on `main`, run the **full Browser E2E** only as the pre-deployment gate on the exact proposed deploy SHA. | Successful dispatch with matching `target_sha`, verified checked-out SHA and browser results |
| 10 | **STOP for explicit separate owner approval.** Do not schedule, script or infer consent from earlier decisions. | Written approval of precisely the proposed production changes and rollback boundary |

**Exact owner approval scope to request, not to presume:**

> Schvaluji samostatné produkční nasazení cílového modelu Lumi pouze pro jednoho vlastníka a soukromé Oblasti, na přesně určeném commitu `<40-znakový SHA>`, s cílovým úložištěm `<ověřená absolutní cesta>`, se zachováním nedotčeného archivního originálu `<identifikátor zálohy>`, ověřenou obnovou a rollback plánem `<odkaz>`. Výslovně schvaluji pouze konkrétně vyjmenované přepínače a datové kroky v předloženém plánu. Neschvaluji smazání jiných databází, lokálních kopií, záloh ani přihlašovacích údajů.

This text is an approval **template**, not an approval. If the owner-approved plan needs data import, migration, cache disposal or replacement, list each exact path and irreversible effect in a **separate** decision before implementing. Until then, all production flags remain off.

## Copy-only rehearsal commands and limitations

Run on a **disposable/offline, previously quiesced snapshot only**, with destinations that do **not yet exist**. Never point these tools to a live server or run them as an agent on production. Both commands require a final `--offline-confirmed` operator assertion; this flag is **not proof** that a source is consistent, offline or non-production. They reject the app's implicit `<cwd>/.data` directory even when `AI_EXECUTIVE_DATA_DIR` is unset, as well as any explicitly configured live legacy/target paths. The shared root-aware containment predicate also rejects nested output under input `/` and handles symlink aliases of existing paths; never run a test against a real root directory. An operator running outside the service environment must independently identify **all** live storage locations, not merely rely on these guards. File-change checks and WAL/hash comparisons are insufficient to prove a coherent original snapshot under concurrent writers: the operator must first use an approved consistent snapshot or stop writers and verify the capture process independently.

```bash
node scripts/cutover-inventory.mjs /offline/legacy-copy /new/inventory-report --offline-confirmed
# Optional, after the operator has checked the *configuration* without exposing
# the actual secret: append --integration-token-present true|false
# immediately BEFORE the required --offline-confirmed flag

node deployment/rehearsal/cutover-restore-rehearsal.mjs \
  /offline/legacy-copy /new/rehearsal-output \
  --target-offline /offline/isolated-target-copy \
  --config-offline /offline/service-config-copy \
  --offline-confirmed

# A second, INDEPENDENTLY captured offline copy can be compared against the
# first copy, including its non-SQLite artifacts. The two input roots must
# resolve to distinct non-overlapping directories (no self-comparison,
# symlink aliases, parent/child inputs). This only validates path separation;
# the operator must independently attest separate, consistent captures.
node deployment/rehearsal/cutover-restore-rehearsal.mjs \
  --verify /offline/legacy-copy /offline/legacy-candidate /new/verify-output --offline-confirmed
```

**Inventory artifact safety:** The inventory report directory contains **only** `inventory.json` and `summary.txt` (both 0600), not `inspection-copy` or another SQLite file. During inspection, the CLI temporarily writes real private database/WAL bytes to a mode-0700 directory named `lumi-r4-inventory-*` under the operator's OS temporary directory (`TMPDIR`/platform temp location). **Before creating it**, the inventory checks the canonical temporary parent against the same known live legacy, target and implicit `<cwd>/.data` locations used for source/report safety; any temp parent inside a known live tree, including through a symlink, is refused. A general temporary parent containing a *separate* live subtree is permitted, because a fresh sibling scratch directory does not overlap that subtree. The check cannot discover unknown production paths when their environment configuration is absent. It deletes the scratch directory on success and caught failures. A hard process kill, system crash or cleanup failure can leave a private scratch copy. Operators must inspect report contents before sharing anything and securely clean abandoned scratch directories. Never share the whole temporary directory or a rehearsal archive as if anonymized.

**Verification semantics:** Default rehearsal mode archives and restores a **single offline source**; it establishes file and SQLite **copy fidelity only**, not an independent backup check. Console output says `SINGLE-SOURCE COPY FIDELITY VERIFIED (NOT independent verification)` and JSON has `verificationScope=single_source_copy_fidelity`. The `--verify` variant checks two separate input roots (`verificationScope=distinct_offline_inputs_equal`) but cannot prove independent, coherent capture; both modes report `independentCaptureEstablished=false`. `verdict=equal` means only that the compared objects match. An independent snapshot plus target security preflight and owner gates remain separate requirements.

**Privacy-safe errors:** The CLIs show explanatory, fixed operator messages for recognized argument/path, SQLite, integrity and copy-mismatch conditions (for example missing `--offline-confirmed` or an existing output destination). Native errors are mapped to allowlisted reasons. Raw exception text, source paths, private values and SQL are never printed; unexpected failures remain generic.

**Privacy and recovery metadata:** The public-facing `rehearsal.json` and console outputs contain no file paths, titles, identities, messages, arbitrary SQLite table names or secret values. In `lumi-r4-rehearsal-v3`, `rehearsal.json.tables` is a list of opaque ordinal IDs (`table_1`, `table_2`, ...) with counts and SHA-256 fingerprints, **not** an object indexed by source-derived SQLite table names (as in the former v2 report). Any downstream report parser must use this v3 format; the ordinal IDs are local to that run, not stable cross-run schema identifiers. Full table names, definitions and data remain solely inside the restricted archival SQLite copies for authorized inspection and integrity comparison. The rehearsal *archive, restored tree and inspection copies* retain the **actual** private contents, encrypted credential blobs and recovery artifacts; generated files are mode 0600 and directories 0700, owned by the operator running the rehearsal. Store the output in a protected operator-controlled location and do not commit or share it.

The **private** `archive/private-file-manifest.json` is mode 0600 and contains an entry for each original file/directory in each provided offline tree (legacy, optional target, optional service configuration, and optional verification candidate). Each entry includes its **original relative name, type, size, SHA-256 for files, original mode and UID/GID**, plus source-root owner and mode. These names are potentially personal and must never be uploaded as general PR evidence. Only the **SHA-256 of this private manifest** and content-tree digest are included in `rehearsal.json`. The manifest is essential for operator-only restoration and must be retained together with the archive.

**Restore/reconstruction rule:** Archival file copies are intentionally normalized to 0600/0700 to prevent disclosure; their original POSIX owners and permissions are **recorded but never automatically reapplied**. Byte-identical recovery is not an operational restore until an authorized operator validates the target service account/UID mapping and explicitly reapplies the recorded permissions/ownership in an isolated restored location. Never alter the archived copies, weaken archive permissions, or run an automatic recursive `chown`/mode restore during this rehearsal. Follow the approved retention and owner authorization policy.

The rehearsal (self-copy fidelity mode, not independent verification) compares all copied file contents byte-for-byte (including legacy backups, credentials and companion artifacts), records original filesystem ownership/modes **including each source root directory** in the private manifest, compares root and descendant metadata for `--verify` and before/after the source copy, verifies archived mode 0600/0700, checks all SQLite rows, SQLite `integrity_check`, `foreign_key_check`, all table/index/trigger/view definitions and sequence contents, and verifies `VACUUM INTO` as an additional complete SQLite archive. Row-digest computation fails closed above **200,000 rows per table** or **16 MiB per encoded row**; an oversized store is a blocker for this tool, **not** permission to skip its verification.

With `--target-offline`, the separate target directory must contain `lumi-target.sqlite`, `lumi-target.journal` and `lumi-target-witness.sqlite`. The archive restores their **bytes** and verifies both SQLite databases, but this does **not** prove journal↔witness↔target semantic consistency. A **separate supported target-store preflight, using only another offline copy**, must demonstrate the append-only journal, anti-rollback anchor, restore-generation and authorization invariants before owner approval. In particular, a mismatched target journal or witness blocks cutover even when directory hashes match. When the target flag is omitted, the report explicitly says `target.status = not_provided` and **cannot** be used as proof of a complete R4 recovery. External environment files and service credentials located **outside** the data directory require an independently obtained, protected offline copy passed with `--config-offline`. Otherwise `externalConfiguration.status = not_provided` blocks any claim of complete credential recovery. Its presence proves byte preservation, not login/service compatibility; test those independently.

The inventory reports actual legacy migration IDs only as a deterministic SHA-256 of the ordered list and compares them with the **pinned, ordered application catalog from `lib/schema-migrations.ts`**. A strict prefix is `known_older` and has a `legacy-migrations-N` version label; a complete exact match is `known_current`. An unknown/non-prefix set is `unknown` with no trusted version label, even when the migration count matches. This reference catalog must be reviewed and updated whenever the app adds migrations; CI compares it to the current source list. The inventory distinguishes `environment_not_inspected` (unknown integration-token presence) from an explicit operator-supplied boolean attestation. The machine cannot establish whether an environment-only secret exists by looking at the legacy SQLite file. Gmail sync inventory reports only aggregate checkpoint status and, when supported, `connectors.sync.reconciliationPending`: the **number of indexed Gmail message rows still marked `needs_reconcile=1`**. `0` confirms no flagged rows in the inspected schema; `null` means the field/table is unavailable and **must not** be interpreted as a clear backlog. `connectors.sync.status=complete` describes checkpoint-column coverage, **not** completed mailbox synchronization; inspect history/discovery pending counts and reconciliation independently. No mailbox IDs, subjects or message contents are printed. The separate `connectors.icloudSync` report provides allowlisted aggregate **stored** statuses for iCloud accounts and linked CalDAV calendar sources, plus earliest/latest successful-sync timestamps. Its `accounts` and `calendars` each have `schema=available` with numeric `total`/fixed-key `byStatus` counters (including `auth_failed`, `error`, `syncing`, `pending`, `ready`, `stale`, `other`) or `schema=not_available` with `null` counts if requisite tables/columns are missing. `0` means inspected and empty; `null` does **not** mean healthy. A stored `ready` state is **not** proof of currently fresh sync—interpret `lastSuccessAt` and check actual operator/service health separately. Only sources linked to an iCloud account with provider `caldav` are counted; independent ICS sources are excluded. No account IDs, calendar labels, error text, encrypted URLs or credentials enter the report or summary.

## Devices and client-held copies (manual, no automation)

The legacy browser uses IndexedDB database `ai-executive` (entities, relations, baseEntities, baseRelations). The isolated note-metadata path, when explicitly enabled, uses a separate IndexedDB `lumi-note-metadata-v1`; existing tabs and installed PWAs can preserve older copies and in-flight requests. No server-side tool can enumerate all private browser profiles, PWAs or offline devices.

1. Inventory each desktop/mobile browser **profile**, installed PWA, active and suspended tab, owner device and offline device; include last online time and a human acknowledgement. Do **not** collect browser cookies, credentials, record titles or cached contents.
2. Before an approved cutover, close/edit-freeze old clients. For every returning client, require reauthentication and a full reload from the server, confirm its trusted owner identity and restore generation, and never submit queued legacy full-snapshot writes. Keep devices offline or quarantined if the acknowledgement is missing.
3. Verify the legacy `x-lumi-restore-generation` barrier (and `baseRevision` on legacy PUT) and target generation/ACL barriers against stale requests, including BFCache restoration. A barrier check is **not** a remote wipe: an offline IndexedDB copy can remain on the device until the person clears or revisits it.
4. Before permitting edits, check there is no cached legacy row visible as an editable target row; verify logout/expired session clears sensitive rendered state. Do not automatically clear IndexedDB as part of #408.

## Rollback *plan*, not an executable command

Preserve both untouched archival sources and the exact deployed code/environment manifest. If an approved deployment later fails: stop all writers, prevent further client edits, record evidence and obtain operator authorization for restoring the **correct matching code + DB + journal/witness + secrets** as a coordinated unit. Target-staging restore is **not** a simple SQLite file replacement: its immutable journal, anti-rollback witness, revocation epochs and restore generation must be reconciled using the supported operator procedure. Never overwrite an existing directory or run the rehearsal as a rollback tool.

After recovery verify SQLite integrity, table counts/hashes against the selected archive, owner auth/revocation, target ACLs, same-origin guards, restore-generation fence and read-only legacy routes. Re-enable writes only after an explicit operator decision and client refresh. A failed archival restore or mismatch is a blocker, not a reason to bypass checks.

## Outstanding release gates

- #388: BFCache lifecycle evidence and stale-client fencing.
- #402: owner-session revocation one-time provisioning (no automatic missing-cutoff reinitialization).
- Exact-SHA release `Browser E2E`, separate from per-PR fast checks.
- Successful independent archival restore and owner sign-off.
- Decision on the production target store directory and how it is backed up together with irreversible journal/witness state.

**No real user data, production state or credentials were touched by preparing this document.**
