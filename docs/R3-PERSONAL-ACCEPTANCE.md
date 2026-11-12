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
2. **Závod při rychlém otevření Quick Capture.** Čtení Mého plánu a výběru Oblastí
   nejdou přes sdílenou frontu `lib/target-read-queue.ts`, server však povolí
   jen dva souběžné read potomky (`lib/target-staging-read-process.ts:42`).
   Klik na **+** do ~0,5 s po načtení dá „Oblasti nelze ověřit“ (obnova:
   Zkusit znovu). Test proto před otevřením čeká na klid požadavků.
3. **Výsledky hledání nejsou otevíratelné** (`app/ui/target-main-title-search.tsx`,
   řádky `<li>` jsou jen text), takže znovu otevřený, ale neplánovaný úkol
   není z UI dosažitelný jinak než přes jeho projekt.
4. **Nově zachycený úkol bez „Kdy“ není v Mém plánu vidět.** Po zavření potvrzení
   („Otevřít úkol“) se k němu z hlavního UI nelze dostat: Můj plán ukazuje jen
   naplánované dny, seznam úkolů cílový režim nemá a výsledky hledání nejsou
   otevíratelné (bod 3). [LUMI-FR-013](PRODUCT.md#lumi-fr-013) přitom říká, že Můj
   plán obsahuje všechny soukromé úkoly uživatele. Test proto úkol plánuje
   přímo z potvrzení. Řeší druhý PR milníku A.
