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

Example, on an isolated *synthetic* fixture or correctly snapshotted copy:

    node scripts/archive-purge-inventory.mjs --db-copy /tmp/lumi-d-review/store.sqlite

The command refuses the canonical /var/lib/ai-executive directory and the
AI_EXECUTIVE_DATA_DIR path, and rejects symlinks to the input file. It may
touch SQLite -shm on its input even with readOnly:true, so do not point it at
an active store. It emits JSON with **counts only**: entity kinds, every table,
work-session task references, workspace-linked rows, attention/notification
references, SQLite integrity status and unfamiliar/missing schema tables.
It never prints item IDs, titles, note bodies or paths.

An inventory with inventoryComplete:true means only that the count scanner saw
the currently classified tables and valid JSON/SQLite. It is **NOT** evidence
that protected data can be deleted or that all logical dependencies are safe.
Review the dependency matrix from #501 and run true protected-table identity
checks, restore rehearsal and synthetic end-to-end acceptance separately.

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
