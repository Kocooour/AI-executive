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
| 6 | Run the copy-only rehearsal in `deployment/rehearsal/` using a new empty output location. Independently compare every table's rows and SHA-256 content digest, confirm SQLite `integrity_check`, and run the tamper/missing-table/non-empty-destination negative tests. | Backup manifest, restore-equivalence report, test results; zero differences |
| 7 | Confirm the proposed target production store location and settings in [R4 target decision draft](R4-TARGET-STORE-DECISION-DRAFT.md); verify its own journal/witness/restore-generation plan and archival recovery, without implementing the switchover. | Owner-reviewed configuration proposal; no target flags enabled |
| 8 | Run typecheck, relevant unit/integration tests, production build and `PR Checks`; resolve all review findings. | Green PR checks and clean full-diff review on current head |
| 9 | After the intended release commits are on `main`, run the **full Browser E2E** only as the pre-deployment gate on the exact proposed deploy SHA. | Successful dispatch with matching `target_sha`, verified checked-out SHA and browser results |
| 10 | **STOP for explicit separate owner approval.** Do not schedule, script or infer consent from earlier decisions. | Written approval of precisely the proposed production changes and rollback boundary |

**Exact owner approval scope to request, not to presume:**

> Schvaluji samostatné produkční nasazení cílového modelu Lumi pouze pro jednoho vlastníka a soukromé Oblasti, na přesně určeném commitu `<40-znakový SHA>`, s cílovým úložištěm `<ověřená absolutní cesta>`, se zachováním nedotčeného archivního originálu `<identifikátor zálohy>`, ověřenou obnovou a rollback plánem `<odkaz>`. Výslovně schvaluji pouze konkrétně vyjmenované přepínače a datové kroky v předloženém plánu. Neschvaluji smazání jiných databází, lokálních kopií, záloh ani přihlašovacích údajů.

This text is an approval **template**, not an approval. If the owner-approved plan needs data import, migration, cache disposal or replacement, list each exact path and irreversible effect in a **separate** decision before implementing. Until then, all production flags remain off.

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
