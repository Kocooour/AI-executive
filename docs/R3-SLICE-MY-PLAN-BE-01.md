# R3-slice / BE-01 + BE-02 — stagingový dvoudenní adaptér Mého plánu

**Stav:** implementační podklad pro první vertikální řez, nikoli aktivovaný produkt. Navazuje na rozhodnutí [5. 11. 2026](decisions/2026-11-05-ui-revize-a-vertikalni-rez.md) a existující task-only `R2d.3l.2` read endpoint.

## Čtecí kontrakt

`GET /api/target-staging/my-plan/slice?evaluationDate=YYYY-MM-DD&areaFilter=all&limit=50`

- Samostatný **výchozí vypnutý** přepínač `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED=true` navíc vyžaduje `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a `AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED=true`. Žádný z nich se touto změnou automaticky nezapíná.
- `evaluationDate` je výslovné místní datum uživatele, nikoli datum počítače/serveru. Odpověď má `today` (otevřené úkoly s nejranější pozorností **nejpozději daný den**) a `tomorrow` (výhradně následující kalendářní den). Úkol se v obou částech neobjeví dvakrát.
- `areaFilter=all|personal|shared` omezuje **Můj plán aktuálně autentizovaného aktéra**. Nikdy to není globální Vše; sdílený úkol se objeví pouze při přiřazení aktérovi a aktuálním `editor/admin` přístupu. `viewer` ani cizí nepřiřazená práce se nepřimíchává.
- Každá část obsahuje `{tasks,hasMore}`; na vrcholu je `{evaluationDate,areaFilter,today,tomorrow,hasMore,nextCursor}`. Limit 1–100 je **na každou část**. Jeden HMAC cursor posouvá obě části nezávisle, je vázán na identitu/session, datum, filtr, limit, staging adresář a restore generation a má nejvýše 15minutovou životnost.
- **BE-02:** oba dny čte **jeden krátký izolovaný podproces v jediné připnuté SQLite read transakci**, s jediným canonical preflightem a actor credential. Výstupy musí mít identický kompletní **Area + private-plan epoch witness**; odlišný nebo neplatný interní výstup se bezpečně odmítne. Následuje **jediné aktuální serverové** ověření session, ACL a epoch proti živému store před vydáním odpovědi. Změna dat po snapshotu → 409. Odpadá okno pro skládání dvou různých snapshotů. Nesoulad kurzoru či revize → 409; po revokaci session → 401. Chybný request/cursor → 400; nenakonfigurovaná staging služba → 503. Odpovědi mají `Cache-Control: no-store`; nezpřístupňují interní svědectví, ID uživatele, cizí přiřazení ani poznámky.
- Na posledním dni reprezentovatelném v kalendářním kontraktu se místo přetečení datumu vrátí 400.

## Zápisy a bezpečné Undo — již existující oddělené endpointy

BE-01/BE-02 **nevytváří nový zápis** ani nerozšiřuje ACL. UI vertikálního řezu následně použije existující nezávisle vypnuté:
- `GET/PATCH /api/target-staging/task-temporal/status` + `POST .../status/receipt` pro CAS dokončení/obnovení a zjištění výsledku nejistého zápisu.
- `GET/PATCH /api/target-staging/task-temporal/personal-when/command` + odpovídající receipt pro soukromé `whenOn` dnes/zítra.
- Před zápisem se vždy vyžaduje aktuální **serverový preview**, aktuální `writeAreaId`, restore generation a revize. Starý preview či revokace se nikdy automaticky znovu neodesílá. Po nejasném výsledku se použije read-only receipt; Undo je **nový reverzní CAS příkaz s novým preview**, ne opakování starého příkazu.
- `409` = konflikt/stale a obnova dat; `401/404` = ztráta přístupu či nedostupnost; `503` = nejistý výsledek (nejprve receipt); offline nesmí vystupovat jako potvrzené dokončení. Pending se nesmí bez ověření zaměnit za úspěch.

## Co zůstává mimo iteraci

BE-01 dodává **task-only read adapter** a testy jeho ACL/revokační hranice; BE-02 zpřísňuje interní čtení na jediný snapshot, testuje aktuálnost epoch a přechody roků/přestupného dne. Veřejný HTTP kontrakt a kurzor se nemění. Neobsahuje kalendářové události ani kapacitu, novou UI obrazovku, propojení skutečných klientských stavů pending/offline/Undo, změnu globálního Vše, cache migraci nebo aktivaci produkčního R3. Další UI-04c/R3 client část musí čtecí kontrakt používat s oddělenými autoritativními zápisy.

Žádný reset, deploy, zásah do produkční DB ani plná Browser E2E. Pro tento PR platí `PR Checks`, cílené testy a code review; plná E2E až před produkčním releasem na přesném SHA.
