# R4 cutover runbook — Quick Capture BFCache release gate

Status: **NOT CERTIFIED** until the evidence below exists on the exact release SHA. This
runbook implements the verification procedure from [#388](https://github.com/Kocooour/AI-executive/issues/388)
and the CI-harness work in [#425](https://github.com/Kocooour/AI-executive/issues/425).
An ordinary successful PR check, a synthetic `PageTransitionEvent`, Back navigation
with a full reload, or a previous commit's successful run is **not** a BFCache hit.

## Scope and safety

- The target under test is the **entire** `personal-v1` flag profile from
  `lib/target-personal-profile.ts`; the real-store browser suite provisions a
  **disposable isolated SQLite** store with a private Area. Never point it at a
  live/production data directory or import private personal content to obtain a hit.
- A passing scoped browser gate does not replace the full Browser E2E run, backup
  validation, authorization checks, restore/cutover approval, or the explicit
  owner's R4 activation decision. Leave Quick Capture default-off until all gates pass.
- Do not suppress BFCache, remove `no-store` for test convenience, emulate
  `pageshow.persisted=true`, weaken the assertion, or skip the failing test.

## C15 root-cause discovery: the earlier run could not exercise BFCache

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

## 1. Pin and run the scoped CI gates

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

## 2. If CI does not restore from BFCache

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

## 3. Manual Chrome / Safari on staging

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

## 4. Closeout evidence for #388 and R4

Attach or link: release SHA, tested/deployed SHA verification, full `personal-v1`
flag list hash/version, browser name/version, workflow run URLs, viewport-specific
`pageshow.persisted` values, `notRestoredReasons` if any, safe proof of draft/Area
removal and authorized wake, reload fallback, one-UUID uncertain POST result,
the separate full Browser E2E gate, backup/restore verification, and explicit
owner approval. Mark gate **UNSATISFIED** if any is absent; do not merge an
assumption of BFCache support into a production activation decision.
