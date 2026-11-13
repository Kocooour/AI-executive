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
| 3 | Resolve #388 BFCache lifecycle failures (see C15 BFCache appendix below) and demonstrate stale/returning clients cannot write old state. | Focused BFCache/restore-generation barrier evidence, exact test SHA |
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

---

## Appendix — C15 Quick Capture BFCache release gate

Status: **NOT CERTIFIED** until the evidence below exists on the exact release SHA. This
runbook implements the verification procedure from [#388](https://github.com/Kocooour/AI-executive/issues/388)
and the CI-harness work in [#425](https://github.com/Kocooour/AI-executive/issues/425).
An ordinary successful PR check, a synthetic `PageTransitionEvent`, Back navigation
with a full reload, or a previous commit's successful run is **not** a BFCache hit.

### Scope and safety

- The target under test is the **entire** `personal-v1` flag profile from
  `lib/target-personal-profile.ts`; the real-store browser suite provisions a
  **disposable isolated SQLite** store with a private Area. Never point it at a
  live/production data directory or import private personal content to obtain a hit.
- A passing scoped browser gate does not replace the full Browser E2E run, backup
  validation, authorization checks, restore/cutover approval, or the explicit
  owner's R4 activation decision. Leave Quick Capture default-off until all gates pass.
- Do not suppress BFCache, remove `no-store` for test convenience, emulate
  `pageshow.persisted=true`, weaken the assertion, or skip the failing test.

### C15 root-cause discovery: the earlier run could not exercise BFCache

The 2026-11-13 PR run for #427 logged `persisted:false` at 390 and 1280 px,
with `notRestoredReasons:null`. **This did not identify an application-level
blocker**: Playwright 1.56 starts Chromium with
`--disable-back-forward-cache` and `page.goBack()` cannot handle a genuine
BFCache thaw (see [Playwright navigation docs](https://playwright.dev/docs/navigations#backforward-cache-bfcache)).
The browser had no opportunity to produce the required real hit.

The corrected suite **does not remove `Cache-Control: no-store` or modify app
security**. The new `e2e/target-personal-native-bfcache.spec.ts` launches an
independent Chromium process without Playwright's BFCache-disabling switch.
It loads the actual isolated personal-v1 application using the disposable
owner session cookie, fills the real Quick Capture task form, performs a
cross-document navigation and the browser's native `history.back()`, and
records the original `pageshow.persisted`, private draft, selected Area,
and fresh authorized reads. This is NOT a synthetic transition.
The manual exact-SHA workflow enforces `persisted === true` in this independent
witness; **a miss makes the release gate fail**. Ordinary PR CI also runs the
witness but only establishes native-browser diagnostics when a hit is absent.

Chrome can sometimes use BFCache even with `no-store`, but there are strict
privacy exceptions: cookies changing and `no-store` XHR responses can evict
entries. Do not infer the sole blocker from the main document header.
See [Chrome's documented conditions](https://developer.chrome.com/docs/web-platform/bfcache-ccns).

#### Native Chromium PR evidence — 13 November 2026 (not a BFCache hit)

[Focused R3 personal acceptance browser, run 43511945915](https://github.com/Kocooour/AI-executive/actions/runs/43511945915)
finished **successfully** as an automatic PR workflow, but had
`LUMI_REAL_BFCACHE_E2E=false`: that green result demonstrates the fallback
and native-browser diagnostic harness, **not** the strict release gate.
It ran PR head `52a5e778e181832a3686a4dbefcd704c6cdd7358` through the
GitHub PR test merge checkout
`54dffa0d09442cca5b972c322fa4b3121a7c135d` (see
`checkedOutSha` in the log), **not** an exact candidate release-SHA dispatch.

The independently spawned **HeadlessChrome/141.0.0.0 on Linux** used native
`history.back()` on the real disposable `personal-v1` SQLite profile.
At **both 390 px and 1280 px** the original `pageshow` observer was active,
but the return had `persisted:false` and a **different document token**.
CDP `Page.backForwardCacheNotUsed` reported all three explanations:

- `MainResourceHasCacheControlNoStore` — **Circumstantial**
- `JsNetworkRequestReceivedCacheControlNoStoreResource` — **Circumstantial**
- `BrowsingInstanceNotSwapped` — **Circumstantial**

The document response was
`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
These are **observed Chrome explanations**, not a proof that BFCache is
fundamentally impossible in all CI Chromiums, in other Chrome versions or
in Safari. Do **not** remove private `no-store`, disable auth, simulate
`persisted:true`, or treat a full reload as a hit. Keep #388 open.

Review [#5898604644](https://github.com/Kocooour/AI-executive/pull/427#pullrequestreview-5898604644)
also identified that checking resource *paths* alone could incorrectly
accept failed session/Area responses. The updated native witness instruments
CDP `Network.requestWillBeSent`, `Network.responseReceived`,
`Network.loadingFinished` and `Network.loadingFailed` **before navigation**.
On a true BFCache hit it now requires new **completed direct HTTP GET 200**
responses, with the owner session response finished *before* the private
Area GET begins, all before another user action. A `401`, `403`, `500`,
aborted request, service-worker response or cached response does not satisfy
this proof. The CDP collector tracks `Network.requestServedFromCache`,
`fromDiskCache` and `fromPrefetchCache` to reject stale authorized reads.
This strict positive-hit path remains **unobserved** until a real hit occurs.

The required follow-up is still a **manual workflow_dispatch of both scoped
workflows at the same exact release SHA in strict mode**, or, if CI cannot
produce a hit, the supported Chrome/Safari staging manual witness from section 3.
It must be accompanied by the separate full Browser E2E, backup/restore and
owner sign-off gates.

### 1. Pin and run the scoped CI gates

1. Select the exact candidate **40-character commit SHA** (record it in the release
   checklist). In GitHub Actions choose the workflow ref that contains these tests
   and manually dispatch **Focused R3 global private capture browser** with
   `target_sha` set to that commit.
2. Manually dispatch **Focused R3 personal acceptance browser** with the **same**
   `target_sha`. Both workflows check out exactly that SHA, assert
   `git rev-parse HEAD == target_sha`, and run with
   `LUMI_REAL_BFCACHE_E2E=true` for the native Chrome witness. The second runs the full `personal-v1`
   isolated target store, not the legacy mocked target API.
3. In both run summaries/logs, record the **actual checked-out SHA**, run URL,
   Chromium version, job conclusion, and the browser evidence:
   `NATIVE_REAL_BFCACHE_EVIDENCE` (authoritative real hit), alongside
   `GLOBAL_CAPTURE_REAL_BFCACHE_EVIDENCE` / `REAL_BFCACHE_EVIDENCE`
   (Playwright full-reload diagnostics only).
   Download the `lumi-r3-global-capture` and
   `lumi-r3-global-native-bfcache` (manual global gate) and
   `lumi-r3-personal-acceptance` artifacts (Playwright attachments and
   traces where present) before retention expires. Record which viewport
   (390 or 1280 px) each result covers.
4. **Pass only when the independent native Chromium's original, browser-fired** `pageshow` event has
   `persisted === true` and the test passes privacy/wake assertions at
   **both 390 and 1280 px** on the real-store profile. A no-hit diagnostic
   is a *failed release gate*, not a pass. PR-triggered runs can validate
   reload behavior but never certify a hit merely by succeeding.
5. Confirm separately that full reload cleared the private draft and that
   the real-store `uncertain` POST test observed **one original UUID pair**,
   one committed CREATE, a blocked composer after reload, and a read-only
   receipt recovery with **no second CREATE**.

For local *scoped* reproduction (only an isolated throwaway test instance;
requires the repository and browser dependencies installed):

```sh
LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true LUMI_REAL_BFCACHE_E2E=true \
  NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1 \
  pnpm exec playwright test e2e/target-personal-native-bfcache.spec.ts --project=desktop
```

Do not use `E2E_SKIP_BUILD=1` unless the production build of the same checkout
already exists. This command does not by itself certify a future release SHA.

### 2. If CI does not restore from BFCache

Do **not** conclude that BFCache is inherently impossible in headless Chromium
from one miss. Preserve the failing job's original console evidence and the
`navigation.notRestoredReasons` tree (including nested frame reasons); note
`null` or unsupported separately rather than inventing a cause. Check the
actual document response's `Cache-Control`, `unload` / `beforeunload`
listeners, pending connections, active service worker, DevTools/CDP and
headless-mode effects. Compare an ordinary supported browser build.

On a failed Back navigation (a new document), the Chrome console can inspect:

```js
const navigation = performance.getEntriesByType("navigation")[0];
console.log({
  type: navigation?.type,
  reasons: navigation?.notRestoredReasons ?? "unavailable",
});
```

An empty/unsupported `notRestoredReasons` value is **not** proof of a particular
blocker. Log the Chrome version and navigation response headers as additional
evidence. If an actual CI hit remains unavailable, keep #388 blocked and
perform the manual procedure below on a disposable staging instance.

### 3. Manual Chrome / Safari on staging

1. Deploy **the same candidate release SHA** to a disposable authenticated
   staging instance, enable exactly the `personal-v1` flags (including
   real target SQLite, owner session, and private Area), and verify the
   deployed SHA. Do not use live data. Repeat at **390 px** and **1280 px**.
2. In a current stable Chrome or Safari, open the page via a *real document
   navigation* (not the Next.js client router), for example
   `/?view=Calendar&scope=personal`. In DevTools enable **Preserve log**;
   do not enable **Disable cache** or an artificial network condition.
   Before leaving the page, register an observer in that page's console:

   ```js
   window.addEventListener("pageshow", (event) => {
     console.log("LUMI_REAL_PAGESHOW_PERSISTED", event.persisted);
   });
   ```

   The observer records only future events. It must be installed *before*
   the cross-document navigation. Do not call `dispatchEvent` or construct
   a `PageTransitionEvent` manually.
3. Open global Quick Capture (+), choose **Úkol**, explicitly choose the
   private **Oblast**, and type a unique sensitive **test-only** task title.
   **Do not save.** Note its exact text and the selected Area only in a
   secure test log (do not paste real private data into a public issue).
4. Navigate the same tab to `/robots.txt` (a genuine full-document
   navigation), then use the browser's **Back** button. The console must show
   `LUMI_REAL_PAGESHOW_PERSISTED true` from the restored application
   document. If it says false or has no such event, report **no hit**.
5. On successful restoration, immediately verify that the old private title
   is absent from all input values and DOM text, that the old Area is not
   selected, and that reopening/selecting an Area reveals a blank title
   (cannot submit the old value). Network logging must show a **fresh
   successful owner-authorized `GET /api/target-staging/session`**, followed
   by a new successful `GET /api/target-staging/notes/create-targets`,
   **before** any new Area-dependent action. There must be **no**
   `POST /api/target-staging/tasks` for the abandoned draft.
6. On a *separate* attempt repeat with a full browser **Reload**; a blank
   draft here proves only reload recovery, **not** BFCache. Separately
   review the CI real-store `uncertain` POST test evidence; don't send
   repeated live CREATEs to simulate a lost response.

Chrome can expose `performance.getEntriesByType("navigation")[0].notRestoredReasons`
on a failed restore. Safari may not expose the same diagnostic; record that
fact explicitly, the exact Safari version, and the real `pageshow.persisted`
result. Do not equate a page loading quickly with BFCache.

### 4. Closeout evidence for #388 and R4

Attach or link: release SHA, tested/deployed SHA verification, full `personal-v1`
flag list hash/version, browser name/version, workflow run URLs, viewport-specific
`pageshow.persisted` values, `notRestoredReasons` if any, safe proof of draft/Area
removal and authorized wake, reload fallback, one-UUID uncertain POST result,
the separate full Browser E2E gate, backup/restore verification, and explicit
owner approval. Mark gate **UNSATISFIED** if any is absent; do not merge an
assumption of BFCache support into a production activation decision.
