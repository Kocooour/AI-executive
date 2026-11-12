# R3 — osobní akceptace „jeden vlastník, jen soukromé Oblasti“

**Milník:** vydání „jeden vlastník, soukromé Oblasti“ (rozhodnutí 2026-11-12).
**Akceptační krok / syntetický:** ano. Jediný prohlížečový test prochází
skutečné route handlery a skutečnou izolovanou target SQLite při **všech**
osobních příznacích najednou. Pouze syntetická data v běhovém adresáři
Playwrightu, default-off, **žádná produkční aktivace**, žádná změna legacy dat.

## Profil příznaků

`lib/target-personal-profile.ts` je čistá data bez I/O a bez vlivu na běh
aplikace (aplikace žádnou proměnnou „profil“ nečte, aktivace zůstává po
jednotlivých příznacích). `TARGET_PERSONAL_V1_PROFILE` je abecedně seřazený
seznam 31 boolean `AI_EXECUTIVE_TARGET_*_ENABLED` příznaků denní smyčky:
target UI runtime, Můj plán (čtení, stav, Kdy, Undo), globální rozsahy
Vše/Osobní/Sdílené pro projekty a poznámky, detaily, úpravy (název/stav/Kdy/
smazání úkolu, úprava a smazání poznámky, název projektu vč. reauth obnovy),
hledání v názvech, výběr soukromé Oblasti a vytvoření soukromé poznámky a
úkolu. `TARGET_PERSONAL_V1_EXCLUDED` vypisuje každý vědomě vynechaný příznak
s důvodem (všechny `*_CLIENT_PREVIEW`, `INDEX_DETAIL_LINKS`, Attention,
notifikace/push, note-sync, relace, Home, kombinovaný a task index, sdílené
termíny `DUE_ON/DUE_WINDOWS`); rodina `AI_EXECUTIVE_HUMANWIKI_*` je vyloučena
celá. `targetPersonalV1Env()` vrací `Record<string,"true">`.
`tests/target-personal-profile.test.mjs` skenuje `lib/` a `app/`: nový příznak
selže, dokud není zařazen právě do jednoho seznamu; dále ověřuje, že profil
zapne všechna pole `targetUiConfig` a ostatní UI brány.

## Akceptační scénář (390×844 i 1280×800)

Přihlášený vlastník otevře Můj plán (čtení ze serveru) → globální Quick Capture
vytvoří soukromý úkol s výslovnou Oblastí (právě jeden `POST /tasks`) → v detailu
nastaví Kdy = dnes, v Mém plánu na zítřek → přejmenuje jej → Projekty/Osobní
ukáží projekt, detail ukáže jeho úkol, projekt se přejmenuje → úkol projektu se
naplánuje, dokončí a vrátí Undo → Poznámky: vytvoření, otevření, úprava →
hledání v hlavním panelu najde úkol, projekt i poznámku → plný reload (vše ze
serveru, nic v localStorage/sessionStorage) → smazání úkolu a poznámky, zmizí
z plánu, seznamu i hledání → po smazání cookie server odmítne obecným 401 a
v DOM nezůstane žádný dříve zobrazený název. Žádný `/api/target-staging/**`
požadavek není mockován (`page.on("request")` pouze počítá).

## Lokální spuštění

```
NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1 pnpm build
LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true E2E_SKIP_BUILD=1 \
  pnpm exec playwright test e2e/target-personal-acceptance.spec.ts --project=desktop
```

Bez `LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E=true` se test přeskočí a nevznikne
žádný store. CI: `.github/workflows/r3-personal-acceptance-browser.yml`
(port 3130, path filter, profilový unit test + build + jen tato spec).

## Co se seeduje a proč

`playwright.config.ts` při prvním načtení spustí `e2e/target-personal-store-setup.mjs`:
`bootstrapIsolatedTargetStore` ve složce běhu (vlastník `e2e-owner`, aktuální
schéma) a přímé SQL pouze pro to, co zatím nelze vytvořit přes UI/API: soukromá
Oblast „Rodina“ a pro každý viewport jeden soukromý projekt s jedním úkolem
(vytvoření projektu a úkolu v projektu je další PR). Cookie z běžného e2e
přihlášení se mapuje na tohoto staging vlastníka.

## Mimo rozsah

Sdílené Oblasti, vytvoření projektu, úkol v projektu, legacy Domů/Doručené/
Dnes, Attention, push/notifikace, HumanWiki, produkční zapnutí.

## Nalezené mezery

1. **OPRAVENO v PR #409 — Undo obnovuje naplánovaný den.** Dokončení dál
   bezpečně odstraní řádek plánu (`personal_task_plan_task_reconcile`), ale
   potvrzení dokončení váže původní osobní den a nové Undo jej obnoví
   atomicky s otevřením úkolu. Obnovu dovolí jen původní potvrzený příkaz,
   nová CAS revize a aktuální oprávnění; revokace ani změna úkolu neobnoví
   zastaralý plán. Ochrana: `tests/target-task-temporal-status-writer.test.mjs`
   a `tests/target-staging-my-plan-slice-http.test.mjs` (R3-A3 Undo).
2. **Závod při rychlém otevření Quick Capture — OPRAVENO v tomto PR.** Čtení
   Mého plánu, výběr Oblastí a `create-preview` šly mimo sdílenou frontu
   `lib/target-read-queue.ts`, ačkoli server povolí jen dva souběžné read
   potomky (`lib/target-staging-read-process.ts:42`); na desktopu k nim přibyl
   postranní panel. Rychlý klik na **+** nebo načtení plánu pak vracely
   „Oblasti nelze ověřit“ / „Bezpečný stagingový přehled není dostupný“.
   Nově `lib/target-app-fetch.ts` (`routeTargetFetch` + jediná fronta) je
   výchozí fetch klientů Mého plánu (slice, preflighty, receipty) a soukromých
   Oblastí (create-targets, create-preview, create-status, create-recovery);
   zápisy frontu nikdy neblokují a `GET /session` (bez potomka) jde přímo.
   `isTargetReadRequest` nově počítá i `create-preview`, `create-recovery`,
   `create-status`. Hlídá to krok 1b scénáře (klik na **+** bez čekání na obou
   šířkách), `peakReads ≤ 2` a `tests/target-app-fetch.test.mjs`.
3. **Výsledky hledání nejsou otevíratelné** (`app/ui/target-main-title-search.tsx`,
   řádky `<li>` jsou jen text), takže znovu otevřený, ale neplánovaný úkol
   není z UI dosažitelný jinak než přes jeho projekt.
4. **OPRAVENO v PR #409 — soukromé úkoly bez data jsou v Mém plánu.**
   Třetí sekce „Bez data“ zobrazuje otevřené úkoly soukromých Oblastí bez
   osobního „Kdy“ a bez termínu; úkoly v projektech dědí Oblast. Po potvrzeném
   Quick Capture se přehled znovu autorizovaně načte, bez optimistického
   doplňování. Ochrana: `tests/target-my-plan-day-task-read.test.mjs`,
   `tests/target-staging-my-plan-slice-http.test.mjs` a
   `e2e/target-personal-my-plan.spec.ts` (390/1280 px, skutečný store).
   Pozn.: nový browser test vyžaduje rozšíření opt-in `testMatch` v
   `playwright.config.ts` vlastníkem souběžného streamu.
5. **OPRAVENO v PR #409 — interní žargon nahrazen srozumitelným textem.**
   Česká i anglická verze Mého plánu, navigace a informační hlášky nyní
   vysvětlují bezpečné ověřování a absenci offline ukládání bez interních
   názvů implementace. Ochrana: `tests/target-my-plan-i18n.test.mjs` včetně
   českého snapshotu a kontroly zakázaných technických výrazů.
6. **Legacy Domů v cílovém režimu (ověřeno, zápis neprochází).** Na 1280 px ukazuje
   Domů legacy úkoly, sekci Pozornost, počty v postranním panelu a ikony řádků.
   V běhu na skutečném store: zaškrtnutí i „Kdy“ jsou `disabled`; položky
   „Odložit o 24 h“ a „Skrýt“ v menu „Další akce“ jsou aktivní, ale
   `blockLegacyWrite` (`app/ui/use-lumi-app.tsx:83`) je zastaví hláškou „Změna nebyla
   provedena…jen pro čtení“, bez zápisu a se stejným legacy store. Při načtení
   stránky proběhne jeden automatický `PUT /api/store` (synchronizační baseline,
   ne uživatelská změna; porovnání s během bez target příznaků neověřeno).
   Inspektor legacy řádku nebyl ověřen.
7. **Odhlášení nezneplatní vlastnický token (potřeba rozhodnutí vlastníka).** Logout
   pouze maže cookie; bezstavový token zůstává na serveru platný až 7 dní
   (`lib/auth.ts`, `app/api/auth/logout/route.ts`); tester jej přehrál na
   `/api/target-staging/tasks`. Krok 12 dokazuje jen odstranění titulů na klientu.

## Příznaky vs. kroky scénáře

Povinná nastavení mimo příznaky: `AI_EXECUTIVE_TARGET_STAGING_DIRECTORY`,
`..._OWNER_USER_ID`, `..._RESTORE_GENERATION`
(`TARGET_PERSONAL_V1_REQUIRED_SETTINGS`). Serverové příznaky (`STAGING_HTTP_*`):
`MY_PLAN_DAY/SLICE` kroky 1, 7, 10; `TASKS_CREATE` 2; `TEMPORAL`, `TEMPORAL_WRITE`
(status, název, smazání úkolu) 3, 5, 7, 11; `PERSONAL_WHEN`, `PERSONAL_WHEN_WRITE` 3, 4, 6;
`GLOBAL_PROJECTS` 6; `PROJECT_TITLE_WRITE` 6; `PRIVATE_NOTE_AREAS` 1b, 2, 8;
`NOTES`, `NOTES_CREATE`, `NOTES_WRITE`, `GLOBAL_NOTES` 8, 11; `TITLE_SEARCH` 9–11;
`WRITE`, `HTTP_ENABLED` všechny zápisy a čtení.
