# R3-slice / BE-01 až BE-05 — stagingový Můj plán a bezpečné CAS

**Stav:** implementační podklad pro první vertikální řez, nikoli aktivovaný produkt. Navazuje na rozhodnutí [5. 11. 2026](decisions/2026-11-05-ui-revize-a-vertikalni-rez.md) a existující task-only `R2d.3l.2` read endpoint.

## Čtecí kontrakt

`GET /api/target-staging/my-plan/slice?evaluationDate=YYYY-MM-DD&areaFilter=all&limit=50`

- Samostatný **výchozí vypnutý** přepínač `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED=true` navíc vyžaduje `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED=true`. Žádný z nich se touto změnou automaticky nezapíná.
- `evaluationDate` je výslovné místní datum uživatele, nikoli datum počítače/serveru. Odpověď má `today` (otevřené úkoly s nejranější pozorností **nejpozději daný den**) a `tomorrow` (výhradně následující kalendářní den). Úkol se v obou částech neobjeví dvakrát.
- `areaFilter=all|personal|shared` omezuje **Můj plán aktuálně autentizovaného aktéra**. Nikdy to není globální Vše; sdílený úkol se objeví pouze při přiřazení aktérovi a aktuálním `editor/admin` přístupu. `viewer` ani cizí nepřiřazená práce se nepřimíchává.
- Každá část obsahuje `{tasks,hasMore}`; na vrcholu je `{evaluationDate,areaFilter,today,tomorrow,hasMore,nextCursor}`. Limit 1–100 je **na každou část**. Jeden HMAC cursor posouvá obě části nezávisle, je vázán na identitu/session, datum, filtr, limit, staging adresář a restore generation a má nejvýše 15minutovou životnost.
- **BE-02:** oba dny čte **jeden krátký izolovaný podproces v jediné připnuté SQLite read transakci**, s jediným canonical preflightem a actor credential. Výstupy musí mít identický kompletní **Area + private-plan epoch witness**; odlišný nebo neplatný interní výstup se bezpečně odmítne. Následuje **jediné aktuální serverové** ověření session, ACL a epoch proti živému store před vydáním odpovědi. Změna dat po snapshotu → 409. Odpadá okno pro skládání dvou různých snapshotů. Nesoulad kurzoru či revize → 409; po revokaci session → 401. Chybný request/cursor → 400; nenakonfigurovaná staging služba → 503. Odpovědi mají `Cache-Control: no-store`; nezpřístupňují interní svědectví, ID uživatele, cizí přiřazení ani poznámky.
- Na posledním dni reprezentovatelném v kalendářním kontraktu se místo přetečení datumu vrátí 400.

## BE-03 — úplná revize pro bezpečné stránkování

- Podepsaný dvoudenní cursor odkazuje na revizi obou oken. Revize teď zahrnuje **všechny tři Area epochy**: `policy_revision`, `content_revision` a `project_content_revision`, včetně oprávněných, ale aktuálně prázdných Oblastí. Nadále obsahuje restore generation, aktéra, filtr, datumy a soukromou plánovací epochu.
- Samostatná změna projektového obsahu tedy zneplatní pokračování starého cursoru (`409`) i tehdy, pokud se `content_revision` úkolů nezměnila. Změny v cizích nepřístupných Oblastech cursor daného aktéra neovlivní.
- Hashovací doména revize se posouvá na `v2`. Staré, nanejvýš 15minutové cursory bezpečně skončí konfliktem a vyžádají nové první čtení; HTTP struktura, HMAC podepisování i ACL zůstávají stejné.
- Regresní test používá výhradně syntetický izolovaný staging SQLite store a prověřuje změnu projektové epochy v prázdné vlastní Oblasti, nezávislost na cizí Oblasti i nové autorizované načtení.

## Zápisy a bezpečné Undo — již existující oddělené endpointy

BE-01/BE-02/BE-03 **nevytváří nový zápis** ani nerozšiřuje ACL. UI vertikálního řezu následně použije existující nezávisle vypnuté:
- `GET/PATCH /api/target-staging/task-temporal/status` + `POST .../status/receipt` pro CAS dokončení/obnovení a zjištění výsledku nejistého zápisu.
- `GET/PATCH /api/target-staging/task-temporal/personal-when/command` + odpovídající receipt pro soukromé `whenOn` dnes/zítra.
- Před zápisem se vždy vyžaduje aktuální **serverový preview**, aktuální `writeAreaId`, restore generation a revize. Starý preview či revokace se nikdy automaticky znovu neodesílá. Po nejasném výsledku se použije read-only receipt; Undo je **nový reverzní CAS příkaz s novým preview**, ne opakování starého příkazu.
- `409` = konflikt/stale a obnova dat; `401/404` = ztráta přístupu či nedostupnost; `503` = nejistý výsledek (nejprve receipt); offline nesmí vystupovat jako potvrzené dokončení. Pending se nesmí bez ověření zaměnit za úspěch.

## BE-04 — atomický stavový CAS náhled

- Stávající `GET /api/target-staging/task-temporal/status?taskId=...` nyní skládá `expectedRevision` a `writeAreaId` s interním task/parent/Area guardem z **jediné kanonicky preflightované, actor-bound, připnuté SQLite read transakce**. Původní dva oddělené podprocesy mohly přečíst rozdílné okamžiky.
- Jeden krátký child vrací pouze interní striktně validovaný DTO; klient nadále vidí přesně `{expectedRevision,writeAreaId,restoreGeneration}`. Zůstává aktuální writer ACL, live session/task/parent/Area ověření před odpovědí, no-store, rate limit, Origin/protokol na PATCH a idempotentní receipt.
- Preview je **pouze čtecí** a neautorizuje zápis: PATCH revaliduje aktuální write ACL, session, generaci a CAS znovu atomicky při commit. Výchozí čtyři staging write flagy zůstávají vypnuté, žádný produkční provoz se neaktivuje.
- Regresní testy ověřují soulad revize s dosavadním API, viewer/cizí úkol, odmítnutí neplatného child DTO a změnu úkolu po snapshotu před live vydáním. Nezměnily se URL ani odpovědi používané klientem UI-03a/03b.

## BE-05 — atomické čtení status receiptu a autorizačního guardu

- `POST /api/target-staging/task-temporal/status/receipt` nyní čte aktuální write-ACL, přesné command-ID potvrzení a task/parent/Area guard v **jediné připnuté, kanonicky preflightované SQLite transakci** pod stejnou actor/session identitou. Dříve endpoint skládal výsledek dvou různě časovaných podprocesů.
- Nový bounded stdin worker má vlastní přísný vnitřní DTO: buď `inaccessible`, nebo současný task witness a jen povolený výsledek receiptu. Větší maximální odpověď je povolena **pouze** tomuto internímu procesu, ostatní write/receipt children zachovávají svůj původní 1 KiB limit. Nikdy se nevydává obsah úkolu klientovi.
- Před odpovědí server dál atomicky ověřuje živou session, roli, task/parent/Area revizi i restore generation; při změně oprávnění nebo úkolu vrátí 401/404, nikoli potvrzení starého zápisu. Vnější odpověď zůstává `{status:"committed"|"not_recorded"}` a stejné chybové kódy. `not_recorded` není povolení opakovat příkaz.
- Přidány syntetické regresní testy pro obě hodnoty receiptu, commit mezi snapshoty, viewer/foreign actor, role downgrade, tampered child DTO a dlouhý název úkolu. API status GET/PATCH, Undo i osobní `whenOn` se tímto PR nemění.

## Co zůstává mimo iteraci

BE-01 dodává **task-only read adapter** a testy jeho ACL/revokační hranice; BE-02 zpřísňuje interní čtení na jediný snapshot, testuje aktuálnost epoch a přechody roků/přestupného dne. Veřejný HTTP kontrakt a kurzor se nemění. Neobsahuje kalendářové události ani kapacitu, novou UI obrazovku, propojení skutečných klientských stavů pending/offline/Undo, změnu globálního Vše, cache migraci nebo aktivaci produkčního R3. Další UI-04c/R3 client část musí čtecí kontrakt používat s oddělenými autoritativními zápisy.

Žádný reset, deploy, zásah do produkční DB ani plná Browser E2E. Pro tento PR platí `PR Checks`, cílené testy a code review; plná E2E až před produkčním releasem na přesném SHA.
