# Milestone D / #501 — Archive-only implementation and operator inventory

This is an implementation note for **D-1**, not permission to delete production data.
The owner confirmed that C-3b PR #492 is deployed on 2026-11-23.
Independent deployment attestations, exact-head tests and the full purge gates
from [#501](https://github.com/Kocooour/AI-executive/issues/501) still apply.

## Scope

- Delete **only legacy Archive** items from the old store, eventually, by a
  separate reviewed operator command. **Do not delete or mutate any current
  target personal-v1 task, note, project, Area, plan, receipt, journal or consent.**
- Preserve Gmail/iCloud calendar, passkeys, HumanWiki, work sessions,
  revocation, push settings and unrelated operational/audit rows.
- Keep [target pre-cutoff test-data cleanup #503](https://github.com/Kocooour/AI-executive/issues/503)
  separate. It is not enabled by Archive cleanup.

## D-1 started — non-destructive inventory only

The first code increment is scripts/archive-purge-inventory.mjs. It does not
support --apply, has no DELETE/UPDATE statements and only opens a **copy** of
the legacy SQLite database in read-only mode.

Create the isolated snapshot through a **reviewed, consistent offline backup**
with the service and all writers stopped. Preserve SQLite WAL consistency:
never invent a backup by copying only store.sqlite while an uncheckpointed WAL
exists. Keep owner data and filenames off CI/GitHub.

The scanner accepts only a **self-contained SQLite backup** without WAL/SHM
sidecars. A matching private operator attestation is mandatory. Its format is
lumi-archive-isolated-copy-v1, with method="sqlite-backup",
consistent=true, sourceStoreIdentity (64-character SHA-256 representing the
approved source identity), sha256 of the isolated database file, bytes of that
file, and referenceSchemaSha256 (approved current-schema DDL digest). Only
the reviewed, stopped-service backup/rehearsal process may issue this
attestation; **do not fabricate "consistent=true" from an arbitrary file**.
The scanner can verify file identity, schema and hashes; it cannot prove
that the human-controlled source/backup attestation is truthful.

Example, on a disposable synthetic fixture or externally attested copy:

    node scripts/archive-purge-inventory.mjs \
      --db-copy /tmp/lumi-d-review/store.sqlite \
      --manifest /tmp/lumi-d-review/verified-provenance.json

The tool refuses direct input from /var/lib/ai-executive or the configured
AI_EXECUTIVE_DATA_DIR, symlinks, hardlinked databases, and input copies with
SQLite -wal/-shm files (including symlinks). It verifies a SHA-256 bound to the
independent manifest both before and after scanning, and compares the full
table/index/trigger DDL digest to the approved reference. A changed trigger
body, missing required column, missing trigger or unknown schema name fails
closed. The same-name schema hash requires a **trusted baseline**; refreshing
the manifest from an unreviewed corrupted schema is NOT validation.

Output is content-free: only approved table names and field names appear,
alongside counts, integrity results, full DDL fingerprint, workspace logical
references and running/paused/completed session-to-Archive-task links.
Unknown table/trigger names (which can themselves contain private text)
are reported by **count**, never printed. Unmatched references may refer
to other stores and are NOT automatically classified as lost. Derived
attention/notification references include tasks, notes, projects, Areas and
workspaces. No row IDs, titles, bodies, private file paths or secret values
are emitted.

An inventory with inventoryComplete:true means only that the scanner saw
the expected tables, required columns/triggers and approved DDL on a
checksum-matched **operator-attested isolated copy** with valid JSON/SQLite.
It is not a destructive preflight and does not prove that the original
source was properly backed up. The independent operator must verify backup
consistency/provenance, protected-table identity, rollback rehearsal and
the #501 dependency matrix before any later --apply mechanism is designed.

The entire D-1 operator implementation remains **pending**:

1. Privileged checkout-independent systemd startup/rollback guard;
   separately trusted first enrollment, witnessed monotonic phases.
2. Durable external retirement fence, safe startup with no auto-reseed,
   server-side rejection of all obsolete legacy write/restore/import routes.
3. Workspace/session dependencies and selective attention/notification cleanup;
   protected-table and target-store invariants.
4. Stopped-service backup/rehearsal, private manifest/digest, explicitly
   approved --apply, crash-safe recovery marker, restore runbook and tests.
5. D-2: retire Archive UI, cache-fence updated clients, two independent
   testers and exact-head synthetic browser acceptance at 390/1280.

Until all of these land and pass the operator gates, **no production purge**.
Historical backups and entirely offline stale browsers are explicitly not
instantaneously erased by deleting the active store.
