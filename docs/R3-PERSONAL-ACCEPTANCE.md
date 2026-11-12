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

1. **Undo dokončení neobnoví naplánovaný den.** Dokončení smaže řádek osobního
   plánu (trigger `personal_task_plan_task_reconcile`,
   `lib/target-store-bootstrap.ts` :409); po Undo je úkol znovu otevřený,
   ale v Mém plánu se neobjeví, dokud se znovu nenaplánuje. Test ověřuje
   otevřený stav v detailu projektu. Reprodukce: naplánovat, Dokončit, Undo.
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
3. **Výsledky hledání — opraveno v pracovním proudu C6 / issue #407.**
   Při zapnutém odpovídajícím detailu je výsledek přístupné tlačítko,
   které otevře existující serverem autorizovaný detail úkolu, projektu či
   poznámky. Neplatné ID a vypnuté druhy detailu zůstávají textem. Po zavření
   se fokus vrací na původní řádek pomocí jednorázového výsledku v paměti,
   který se při změně oprávnění, identity, dotazu, rozsahu, skrytí či odpojení
   zahodí. Krytí: `tests/target-main-title-search-ui.test.mjs`,
   `e2e/target-main-title-search.spec.ts` (vypnuté příznaky),
   `e2e/target-personal-search-open.spec.ts` (real-store opt-in). Poslední
   prohlížečový test čeká na zařazení do `playwright.config.ts` vlastníkem
   integračního milníku; do té doby **nelze tvrdit, že akceptace prošla**.
4. **Nově zachycený úkol bez „Kdy“ není v Mém plánu vidět.** Po zavření potvrzení
   („Zobrazit úkol“) se k němu z hlavního UI nelze dostat: Můj plán ukazuje jen
   naplánované dny, seznam úkolů cílový režim nemá a výsledky hledání nejsou
   otevíratelné (bod 3). [LUMI-FR-013](PRODUCT.md#lumi-fr-013) přitom říká, že Můj
   plán obsahuje všechny soukromé úkoly uživatele. Test proto úkol plánuje
   přímo z potvrzení. Řeší druhý PR milníku A.
5. **Interní žargon v textech cílového režimu (neopraveno).**
   `lib/target-my-plan-copy.ts:106` („stagingový přehled“), `:127`–`:128`
   („Izolovaný stagingový…“, „novým CAS“), `:168` („dueOn“, „Každý zápis
   vyžaduje nový CAS; žádná offline fronta.“), `:169` („serverové CAS“),
   `app/ui/lumi-app-root.tsx:267` („ze stagingu“), `app/ui/views/sidebar.tsx:165`
   a `app/ui/views/mobile-nav.tsx:43` („serverový plán ze stagingu“).
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
