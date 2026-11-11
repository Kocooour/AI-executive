# R3-FE-6 — Quick Capture soukromého samostatného úkolu

**Milník:** [R3 private task create](R3-BE-04C-PRIVATE-TASK-CREATE-HTTP.md),
třetí ze 3 plánovaných integračních PR (#390 core → #393 HTTP + exact receipt → tento FE).
**Akceptační krok / syntetický:** skutečný default-off klientský formulář hlavního
Lumi UI odešle právě jeden reálně autorizovaný private task CREATE na existující
HTTP API. Testy používají pouze syntetická data, bez zapnutí produkce nebo R4.

## Uživatelský tok

1. V opt-in UI při současně povoleném cílovém Notes/Area transportu a vlastních
   task-write branách globální plovoucí **+** (telefon, desktop, klávesová
   zkratka i detail) nabídne **Úkol / Poznámka**. V Notes obrazovce zůstává
   přímá akce Nová soukromá poznámka beze změny. Žádná záložka Hledání ve
   spodním menu se nezavádí. Při vypnuté task UI bráně zůstává starý notes-only
   tok přesně zachován.
2. Formulář úkolu čerstvě načítá serverově autorizované soukromé zapisovatelné
   Oblasti z `GET /api/target-staging/notes/create-targets` (transportní
   sdílení s poznámkami). Uživatel **vždy výslovně** vybere Oblast. Před
   odesláním proběhne `POST /api/target-staging/notes/create-preview` pro
   read-only `restoreGeneration`. Toto samo není oprávnění k zápisu;
   task create HTTP znovu ověřuje živou identitu, Area, generation a
   transakční ACL.
3. Jediný nový `taskId` a `commandId` se vytvoří před jedním
   `POST /api/target-staging/tasks`. Podporuje jen samostatný soukromý
   úkol, bez projektu, přiřazených osob, sdílení, termínu a priority.
   Výsledek se **nepřidává optimisticky** do Mého plánu (úkol nemá Kdy).
   Viditelná zpráva v hlavní obrazovce se objeví až po přesném serverovém
   potvrzení. Jde o runtime událost nezávislou na životnosti formuláře:
   i po zavření dialogu se opožděně potvrzený zápis projeví v hlavní
   obrazovce. V oznámení je **Zobrazit úkol**, které otevře existující
   serverově autorizovaný detail `MyPlanPreview&taskId=…`; při čtení
   ve Sdíleném přepne čtecí rozsah na Osobní. UI je proto k dispozici jen
   současně s povoleným cílovým Mým plánem a autorizovaným detailem úkolu.
   Tato cesta nezavádí neautorizovaný seznam ani optimistický řádek.
4. Timeout, revokace během requestu, nevysvětlené 4xx/5xx, neplatná 2xx
   odpověď a výpadek sítě jsou **uncertain** — žádný nový příkaz,
   automatic retry, local insert, legacy fallback ani klientské Undo.
   Stavový marker v `sessionStorage` obsahuje **pouze**
   `{generation,commandId}`. Celý příkaz včetně názvu zůstává pouze
   v paměti stejné aktuální autentizační runtime. Volitelné potvrzení
   v otevřené relaci volá `POST /api/target-staging/tasks/create-status`
   se **stejným nezměněným příkazem**. Po úplném reloadu, kdy už text
   není v paměti, volá `POST /api/target-staging/tasks/create-recovery`
   pouze s neprůhledným `commandId`. Server v odděleném stagingu
   dohledá atomicky uložený actor-bound záznam obsahující jen ID úkolu,
   ID Oblasti a restore generation (bez názvu úkolu), ověří živou
   identitu, soukromou Oblast, oprávnění a samotný existující úkol.
   Klient obdrží jen `committed`/`not_recorded` bez názvu/ID.
   Bariéra se uvolní **pouze** při potvrzeném `committed`.
   `not_recorded` není důkaz neprovedení.
5. Vypršení 8sekundové lhůty ověření Oblasti vrátí dialog do bezpečně
   opakovatelného výběru; nejde o odeslaný CREATE. Timeout read-only
   ověření `create-status` znovu zpřístupní **Ověřit původní zápis**
   bez změny `commandId` či přenosu titulku do storage.
6. Offline, skrytí stránky, pagehide, BFCache a změna generace smažou
   rozpracovaný privátní text, výběr Oblasti a staré read výsledky.
   Neodmountují už odeslaný POST ani nemažou jeho marker. Znovu otevřený
   dialog bez známé aktuální identity nezačne zápis. Escape/Zavřít
   vrátí fokus na původní tlačítko/fallback FAB.

## Bezpečnostní omezení a release kontrola

Soukromý text úkolu se nikdy neukládá do `sessionStorage` ani
`localStorage`. Při CREATE se v jedné připnuté transakci s úkolem
a původním digest potvrzením zapíše druhý content-free metadata svědek
(actor+command hash -> `{taskId,areaId,restoreGeneration}`).
Svědek je striktně validován canonical store preflightem; read-only
worker jej vydá jen do serverového procesu, nikoli do klienta.
Čerstvé HTTP ověření požaduje původní `commandId`, ale nikdy nevrací
privátní název, ID úkolu ani Oblasti a znovu kontroluje živá oprávnění.
Neověřený, revokovaný, změněný nebo jinému actorovi patřící zápis
ponechá klienta zablokovaného. Neexistuje časové odblokování, nové
UUID, ani automatické opakování CREATE.

Tento nový backendový protokol řeší technický problém zaznamenaný
v [#398](https://github.com/Kocooour/AI-executive/issues/398);
jeho přijetí stále vyžaduje úspěšné HTTP/SQLite a browser testy,
nezávislou bezpečnostní revizi a release E2E. Flagy zůstávají
default-off; samotná implementace není produkční schválení.

Další omezení: UI při současné implementaci vyžaduje všechny stávající
Notes Create + Private Area transport flagy, protože znovu používá jejich
read-only Area katalog a preflight. Jde o dočasnou explicitní závislost;
samostatný task Area transport by byl další backendová iterace a
**není** v tomto PR.

## Brány a validace

- Samostatné flags: `AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED=true`
  a `AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED=true` nad
  již existujícím `targetPrivateNoteCreateUiEnabled` a serverovými
  `HTTP_ENABLED` / `HTTP_WRITE_ENABLED`. Nově i současně aktivní
  cílový Můj plán (`config.myPlan.enabled`) a task detail
  (`config.details.task`), jinak formulář úkolu není nabídnut.
  **Výchozí stav false.**
- Cílený test: `node --experimental-loader ./tests/ts-loader.mjs --test tests/target-private-task-create-ui.test.mjs`
  — flag matrix, DTO parser, no-store, exact original command receipt,
  content-free barrier, uncertain → not_recorded → committed,
  reload/generation deny, obsahově prázdné UUID recovery a základní integrace UI.
- Existující skutečná HTTP/SQLite test suite:
  `tests/target-staging-private-task-create-http.test.mjs`,
  `tests/target-private-task-create-writer.test.mjs`.
- Přidána cílená izolovaná Playwright sada
  `e2e/target-private-task-create.spec.ts` a
  `.github/workflows/r3-private-task-create-browser.yml`: reálný React
  390/1280 px, syntetické HTTP a Area volby, právě jeden POST, serverové
  potvrzení a přechod do detailu, zavření/opětovné otevření při pending,
  exact receipt, privacy při reloadu a oba timeouty. CI výsledek
  vyhodnocovat na přesném HEAD; existence testu není jeho průchod.
- Před produkčním nasazením ověřit samostatně dostupnost/ztrátu přístupu,
  reálný BFCache hit a kompletní Browser E2E na přesném release SHA podle
  [AGENTS.md](../AGENTS.md).
- `main` obsahuje #393; nezávisle otevřený [#391](https://github.com/Kocooour/AI-executive/pull/391)
  mění stejný shell. Před merge je nutná integrační kontrola s jeho
  aktuálním HEAD, review, úspěšné PR Checks a vyřešení všech nálezů.
- Bez reálných osobních dat, importu, resetu databáze, R4 souhlasu,
  produkční aktivace nebo nasazení. Případné další PR překračující
  tří-PR rozpočet milestone musí dostat nové rozhodnutí vlastníka.
