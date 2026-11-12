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
   `not_recorded` neobsahuje žádné ID; pouze při `committed` po všech živých
   kontrolách server vrátí neprůhledné `taskId` pro autorizovaný detail,
   nikdy soukromý název, Oblast ani identitu. V UI vznikne oznámení
   **Zobrazit úkol** i po reloadu; v browser storage zůstává jen marker.
   Bariéra se pro navigaci k existujícímu úkolu uvolní **pouze** při
   autorizovaném `committed`; samostatně lze ručně uvolnit jen po trvalém
   terminálním důkazu `cancelled` nebo `settled` z cancel endpointu.
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

## Bezpečné zrušení nepotvrzeného CREATE

Pokud HTTP `CREATE` vrátí `429`, `403`, jiný neúspěch nebo timeout,
klient zachová obsahově prázdný blokující marker. Samotné `not_recorded`
nikdy **není** důkaz, že původní požadavek už nemůže později doběhnout.

Uživatel může explicitně zvolit **Zrušit nepotvrzený zápis**.
`POST /api/target-staging/tasks/create-cancel` přijímá jen neprůhledné
`{commandId}` a vyžaduje skutečnou živou session, origin/protocol,
restore generation, funkční staging a samostatnou write feature gate.
Samostatný child pod serverovou identitou vloží trvalou actor+command
cancel fence v pinned `BEGIN IMMEDIATE` transakci; původní CREATE
pod stejným zámkem prověřuje tento fence před vložením úkolu.

- `cancelled`: zrušovací zábrana zvítězila v připnuté transakci;
  tento actor+command už nemůže vytvořit úkol ani při opožděném POST.
- `settled`: pod stejným připnutým zámkem existuje neměnný actor+command
  receipt původního CREATE. Opakování téhož UUID smí pouze selhat nebo
  idempotentně vrátit původní výsledek; další úkol nevloží. Platí i po
  **smazání** úkolu či pozdější ztrátě přístupu k jeho Oblasti.
  Odpověď obsahuje výhradně `{status:"settled"}`, žádný taskId, oblast
  ani soukromý text. Není to potvrzení přístupnosti původního úkolu.
- Oba terminální důkazy odblokují **pouze nové vytvoření**, až po ověření
  živé identity, aktuální generace a přesného markeru v sessionStorage.
  Navigace na původní úkol vyžaduje nezávislé `create-status` nebo
  `create-recovery` s živým ACL a task/Area guardem.
- Chyby, odmítnutí, výpadky, `not_recorded` a zastaralé `committed`
  na cancel endpointu zachovávají blokaci.
  Po změně identity/generation nelze cizí marker zrušit pouhým
  přihlášením jiného účtu.

Zrušovací marker je append-only staging metadata, bez titulku, Area,
task ID a soukromého obsahu. Patří mimo legacy backup scope, má
samostatný cap, tvar kontrolovaný canonical preflightem a journal witness.
Systém zůstává default-off; release E2E i bezpečnostní review jsou
stále podmínkou produkční aktivace.

## Bezpečnostní omezení a release kontrola

Soukromý text úkolu se nikdy neukládá do `sessionStorage` ani
`localStorage`. Při CREATE se v jedné připnuté transakci s úkolem
a původním digest potvrzením zapíše druhý content-free metadata svědek
(actor+command hash -> `{taskId,areaId,restoreGeneration}`).
Svědek je striktně validován canonical store preflightem; read-only
worker jej vydá jen do serverového procesu, nikoli do klienta.
Čerstvé HTTP ověření požaduje původní `commandId`, znovu kontroluje živá
oprávnění a vrací `taskId` výhradně při potvrzeném, aktuálně autorizovaném
`committed`, nikdy privátní název nebo Oblast. Odmítnutí a `not_recorded`
neobsahují identifikátor žádného úkolu.
Neověřený, revokovaný, změněný nebo jinému actorovi patřící zápis
ponechá klienta zablokovaného. Neexistuje časové odblokování ani
automatické opakování původního CREATE. Nové UUID smí vzniknout až
po potvrzeném terminálním důkazu, nikoli při pouhém `not_recorded`.

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
- `main` obsahuje #393 i již sloučené autorizované vyhledávání
  [#391](https://github.com/Kocooour/AI-executive/pull/391). Společný shell
  zachovává oddělení serverových titulů od lokálních legacy úkolů.
  Cílený společný browser test na 390px i desktopu kontroluje Search a
  Quick Capture v jedné relaci, bez automatického hledání či lokálního
  optimistického vložení. Nezávislé review a zelené HEAD CI zůstávají branou.
- Bez reálných osobních dat, importu, resetu databáze, R4 souhlasu,
  produkční aktivace nebo nasazení. Případné další PR překračující
  tří-PR rozpočet milestone musí dostat nové rozhodnutí vlastníka.

## Sjednocení #395 a #396

[#395](https://github.com/Kocooour/AI-executive/pull/395) je překrytý
starší experimentální variantou, která nedokáže bezpečně rozlišit výsledek
neznámého CREATE po reloadu. #396 zůstává jedinou integrační implementací:
zachovává explicitní privátní Oblast, jediný idempotentní POST,
modal-independent oznámení a fail-closed marker, ale navíc obsahuje
actor-bound HTTP/SQLite recovery a browser/HTTP testy. Alternativní
dialog ani neúplný recovery fallback z #395 se nepřidává.
