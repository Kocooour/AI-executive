# R3-FE-4b — úpravy v autorizovaném detailu

**Stav:** default-off, bez produkční aktivace. Druhý ze tří plánovaných PR milníku „R3-FE-4 + integrované R3 QA“ ([ROADMAP](ROADMAP.md)); navazuje na [R3-FE-4a](R3-FE-04A-DETAILS.md) (detaily jen pro čtení) a používá jeho bariéru zápisů do legacy dat, frontu čtení, stavový automat probuzení a pravidla ID. Nevzniká nová serverová trasa, tabulka ani nové oprávnění. Stávající read-only detail úkolu byl kompatibilně rozšířen o volitelný neprůhledný CAS token pro aktuálně oprávněné editory; UI stále používá izolované stagingové trasy.

## Co přibylo

V detailu úkolu a poznámky (panel uvnitř hlavní aplikace, jen cílový režim):

| Druh | Ovládací prvek | Trasa (jediné odeslání) | Undo |
| --- | --- | --- | --- |
| úkol | **Upravit název** | `PATCH tasks/[id]/title` | ano: původní název (nový příkaz) |
| úkol | **Dokončit / Obnovit úkol** | `PATCH task-temporal/status` | ano u dokončení (znovu otevřít), jako v Mém plánu |
| úkol | **Kdy: Dnes / Zítra** (jen soukromý úkol nebo úkol přiřazený mně) | `PATCH task-temporal/personal-when/command` | ano: předchozí hodnota |
| úkol | **Smazat úkol** (s potvrzením) | `POST tasks/[id]/delete` | ne (server Undo smazání nemá) |
| poznámka | **Upravit poznámku** (název + text) | `PATCH notes/[id]/edit` | ne |
| poznámka | **Smazat poznámku** (s potvrzením) | `DELETE notes/[id]` | ne |

Vytváření úkolů a poznámek **není součástí** (cílové API pro vytváření stále chybí, backendová mezera). Úpravy projektu v detailu projektu nejsou součástí (detail projektu zůstává jen pro čtení). Osobní „Kdy“ detail úkolu nezobrazuje (čtecí DTO ho nenese), proto UI po uložení hlásí jen potvrzení; stav „Kdy“ je vidět v Mém plánu.

## Příznaky

`targetUiConfig(env).edits = {taskTitle, taskStatus, taskWhen, taskDelete, noteEdit, noteDelete}` (prosté booleany). Každý prvek vyžaduje **všechny** tyto příznaky přesně `"true"`; chybějící příznak odstraní jen ten prvek, bez příznaků je chování identické s 4a (včetně věty „Zobrazení je zatím jen pro čtení“ a žádného dalšího požadavku):

- společné: `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `AI_EXECUTIVE_TARGET_UI_ENABLED`, `AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED`, **`AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED`**, `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`, plus příznak detailu daného druhu (úkol `…_TEMPORAL_ENABLED`, poznámka `…_NOTES_ENABLED`);
- název, dokončení/obnovení a smazání úkolu: `…_HTTP_TEMPORAL_ENABLED` + `…_HTTP_TEMPORAL_WRITE_ENABLED`. Důvod: trasy názvu a smazání nevracejí `restoreGeneration` ani Oblast; CAS token (stejný jako `snapshotRevision`, `lib/target-task-write-preflight.ts`), `writeAreaId` a `restoreGeneration` dává read-only preflight `GET task-temporal/status?taskId=`, jehož příznaky se proto vyžadují také;
- osobní Kdy: `…_HTTP_PERSONAL_WHEN_ENABLED` + `…_HTTP_PERSONAL_WHEN_WRITE_ENABLED`;
- poznámka (úprava i smazání): `…_HTTP_NOTES_ENABLED` + `…_HTTP_NOTES_WRITE_ENABLED` (preflight `GET notes/[id]/edit` vrací CAS, Oblast i generaci).

Příznaky Mého plánu (`…_MY_PLAN_STATUS_UI_ENABLED`, `…_MY_PLAN_WHEN_UI_ENABLED`) se pro detail **nevyžadují**; patří Mému plánu. Příznak jen vykresluje UI, **není oprávnění**: každý požadavek autorizuje server (identita, Oblast, CAS, restore bariéra).

## Role a editovatelnost

Detail (`task-temporal/detail`, `notes/[id]`) nenese roli ani oprávnění. UI proto **nikdy** neodvozuje editovatelnost z rozsahu (`scope`), druhu Oblasti ani domněnky o roli. Po každém úspěšném načtení obsahu se přes frontu čtení pošle read-only preflight; odpověď serveru rozhoduje:

- úspěch → ovládací prvky se zobrazí (server při zápisu znovu autorizuje);
- 404 (viewer, cizí, odvolané, vypnuté – jedna nerozlišitelná odpověď), jiná chyba nebo nečitelná odpověď → **žádné prvky**, jen věta „Tuto položku můžete jen číst.“ Prvky se nikdy neukazují „na zkoušku“;
- během ověřování stojí „Ověřuji, zda ji můžete upravit…“ (prvky nejsou).

Preflight se opakuje při každém novém čtení obsahu (otevření, tik ~60 s, probuzení, po zápisu), takže ztráta role prvky odstraní. Zápis po ztrátě práva skončí na serveru (preflight 404 = `forbidden`, před jakýmkoli odesláním; viz stavy).

## Stavový model zápisu (`lib/target-detail-write.ts`)

Jeden čistý reducer a jeden řadič (`createWriteController`) pro všech šest druhů. Stavy:

```
idle → pending(preparing → dispatched) → committed (Undo, nebo smazáno)
                                        | conflict
                                        | uncertain (checking, notRecorded)
                                        | error (invalid | forbidden | unavailable | rate-limited | invalid-response)
offline (bez odeslání)
```

Pravidla (všechna testovaná):

- **Jedno odeslání.** Zápis se pošle **právě jednou**. Až do `dispatched` se nic nezměnilo (selhání preflightu = chyba/konflikt bez zápisu). Další zápis se ignoruje při `pending` i `uncertain`.
- **Konflikt** (HTTP 409: CAS/revize, idempotence, nezměněno; nebo Oblast na obrazovce ≠ Oblast preflightu): klidná věta „Položka se mezitím změnila jinde. Načetli jsme aktuální obsah a nic jsme nepřepsali.“, detail se znovu načte (tichým nahrazením obsahu), **text uživatele zůstane viditelný** (jen pro čtení, ke zkopírování) s volbami „Upravit znovu nad aktuálním obsahem“ a „Zahodit můj text“. Žádný automatický retry.
- **Optimistická souběžnost na tom, co uživatel viděl.** CAS se bere čerstvý při uložení (nese ho preflight těsně před zápisem). Aby úprava názvu/textu nepřepsala cizí změnu provedenou po otevření editoru, řadič po preflightu **přečte** položku (přísným čtecím klientem) a porovná ji se základem, z něhož editace vznikla (název, u poznámky název + text, Oblast). Rozdíl nebo zmizení položky = konflikt **před** odesláním. Změna mezi preflightem a čtením je vidět v porovnání, změna po čtení zneplatní CAS (409).
- **Uncertain** (síť, timeout 30 s, 5xx, nečitelný/neznámý úspěch, pozdní 401/403/404 po odeslání): původní příkaz zůstane v paměti, **nikdy se neposílá znovu**. Hned po odeslání se přes read-only receipt tohoto příkazu ověří výsledek: `committed` → potvrzeno; `not_recorded`, odepřený nebo nečitelný receipt → zůstává uncertain (neprokazuje, že se nezapsalo). Uživatel může ověření opakovat tlačítkem „Ověřit uložení“; do té doby jsou další změny vypnuté. Zdroj receiptu = stávající trasy (`…/title/status`, `…/delete/status`, `…/edit/status`, `…/status/receipt`, `…/personal-when/command/receipt`).
- **Chyba:** 400 → `invalid`; preflight 404 → `forbidden` (jen pro čtení); 429 → `rate-limited`; 5xx/síť před odesláním → `unavailable`; nevalidní odpověď → `invalid-response`. Nic se nezměnilo, text zůstane.
- **Offline:** bez odeslání (`online()` se čte při spuštění zápisu), stav `offline`, klidná věta; text se zachová. Skutečný offline událost odstraní obsah panelu jako v 4a (soukromí); rozepsaný text (jen v paměti React stavu panelu, **nikdy v úložišti**) se po návratu online a znovunačtení obsahu objeví v otevřeném editoru. Skrytá záložka se chová stejně.
- **Revokace / 401 uprostřed zápisu:** před odesláním (preflight 401) → stav `idle` + stávající rozpočet odmítnutí (`onRefusal`, detail se odstraní). Po odeslání je 401 **nejasný** (owner cookie se po commitu kontroluje znovu) → `uncertain` a příkaz se zachová pro ověření receiptem po obnově přístupu; odepřený receipt jde také přes rozpočet odmítnutí a uncertain zůstává. Ztráta přístupu (`signed-out`, `stale`, `not-available`) rozepsaný text smaže; skrytí/offline ne.
- **Změna generace detailu / rozsahu / zavření panelu:** `reset()` zruší feedback a Undo, zruší probíhající přípravu (nic se neodešle), uncertain a už odeslaný zápis zůstanou k ověření, pozdní odpověď se ignoruje (nezobrazí se zastaralé „uloženo“). Zavření panelu příkaz zahodí (jen paměť).

## Undo

Vázané na generaci detailu, zrušené při `reset()` a při dalším zápisu. Vždy **nový příkaz** s čerstvým CAS; starý se nikdy neopakuje. Před Undo se receiptem potvrdí, že původní příkaz opravdu proběhl. Název: čerstvý preflight → čtení → porovnání (změnil-li název mezitím někdo jiný, Undo skončí jako konflikt a nic nepřepíše). Dokončení/Kdy: stávající logika Mého plánu (`prepareConfirmedMyPlanUndo`, `prepareConfirmedWhenUndo`). Undo se nedá vrátit znovu. Smazání a úprava poznámky Undo nemají (server ho nenabízí).

## Smazání

Vložené potvrzení (ne nativní dialog, ne druhý modální): text s názvem, bezpečná volba „Nemazat“ má fokus, **Esc** potvrzení zruší dřív než panel a vrátí fokus na tlačítko. Při otevření potvrzení se zároveň zmrazí původní snapshot a potvrzovací text; pro úkol se také uchová **CAS revize získaná ve stejném autorizovaném SQLite snapshotu jako detail**. Server ji vydává pouze u oprávněného editora s aktivními write flagy. Mazání úkolu bez revize se nenabídne; při potvrzení se token porovná s novým preflightem i opětovným autorizovaným detailem. Zachytí se tím i skryté změny přiřazení nebo změna a vrácení hodnoty, které viditelný náhled neodhalí. Následný serverový CAS pod transakcí uzavírá interval do odeslání DELETE. Změna stejné položky v jiné záložce nebo během potvrzování vyvolá konflikt před mazáním, nikoli nevratnou ztrátu nových úprav. Po potvrzeném smazání se místo obsahu zobrazí „Úkol/Poznámka byla smazána…“ s tlačítkem Zavřít (fokus), detail se znovu nečte (404 by větu přepsal), starší rozběhnuté GET odpovědi se zneplatní a seznamy se obnoví.

## Obnovení seznamů po potvrzeném zápisu

`lib/target-data-invalidation.ts` je paměťová sběrnice (druh + neprůhledné ID). Po `committed` (i po ověření receiptem) řadič **nejdřív** zařadí do fronty čtení znovunačtení otevřeného detailu, **potom** vyšle změnu; odebírají ji seznamy Projekty/Poznámky (stejná funkce jako tik: první stránka a návrat na počet načtených stránek, staré řádky se nahradí jen celým novým výsledkem), postranní panel projektů a Můj plán (stávající GET-only `refreshPlan` se svými ochranami: neběží během vlastního zápisu/uncertain Mého plánu). Čtení jdou frontou po jednom (server povoluje 2 souběžné čtecí děti).

## Fronta čtení a zápisy

`lib/target-edit-fetch.ts`: čtení (`GET`) a kontroly receiptu (`POST …/status`, `…/receipt`; server je čte v čtecím dítěti) jdou sdílenou frontou `queuedTargetFetch`; **zápisy (`PATCH`, `DELETE`, `POST …/title|delete|edit`) frontu neobsazují**, aby zaseknutý zápis nezablokoval všechna čtení. Zápis má vlastní timeout 30 s (po odeslání = uncertain).

## Přístupnost

- Trvalá `aria-live="polite"` oblast (pending, potvrzeno, offline) a samostatný `role="alert"` pro konflikt, uncertain, chybu a zablokované odeslání.
- Klávesnice: všechny prvky jsou tlačítka/pole, Enter ukládá, **Esc ruší editaci (nebo potvrzení) dřív než panel**, druhé Esc panel zavře; po uložení/zrušení se fokus vrací na tlačítko, které editor otevřelo.
- Cíle ≥ 44 px, na 390 px se tlačítka zalamují do plné šířky; tmavý motiv má vlastní barvy varování.
- Chybová a potvrzovací hlášení bez kódů, ID a revizí; texty cs/en s kontrolou shodných klíčů (`lib/target-edit-copy.ts`).

## Bariéra zápisů do legacy dat (dokončení 4a)

V sjednoceném režimu jsou už **nativně vypnuté** (ne jen upozornění při pokusu): táhlo řazení (`dragHandle`: `disabled`, `draggable=false`, bez pointer/klávesového přesunu), pole stránky projektu (název `readOnly`, Oblast a termín `disabled`, akce Dokončit/Smazat pod `LegacyWriteGate`) a akce v časové buňce Dnes (přijmout, odložit, přeskočit, dokončit, smazat). Zůstává blokace v `use-lumi-app` a upozornění při pokusu.

## Hranice a známé mezery

- **Vytváření** (Quick Capture, nový úkol/poznámka) – cílové API chybí (backend); legacy zápisy zůstávají zakázané.
- **Synchronizace legacy dat na pozadí** v sjednoceném režimu zůstává pro QA (PR 3/3).
- Task title/smazání vyžadují příznaky `…_TEMPORAL_WRITE_ENABLED` jen kvůli zdroji CAS/generace; samostatný preflight s `restoreGeneration` na trasách názvu/smazání by byl čistší (backendová poznámka).
- Detail úkolu nezobrazuje osobní „Kdy“ ani roli; UI se řídí odpovědí preflightu. Detail projektu je jen pro čtení.
- Souběžnost: CAS je čerstvý při uložení a obsah se porovnává se základem editace; mezi čtením a PATCH zbývá okno zachycené CAS (409 → konflikt).

## Testy

`tests/target-staging-edit-clients.test.mjs` (tvar požadavků, přísné parsování, jedno odeslání, receipt), `tests/target-detail-write.test.mjs` (reducer + každý výsledek pro každý druh, žádné automatické opakování, receipt, offline, revokace, reset, timeout, souběžnost), `tests/target-edit-config.test.mjs` (matice příznaků, shodné cs/en klíče, směrování fronty, sběrnice změn), `tests/target-edit-ui-wiring.test.mjs` (zapojení, Esc, živé oblasti, žádné úložiště, bariéra legacy zápisů). Prohlížečové scénáře (vlastní izolovaný build a syntetický store): úprava názvu vlastníkem a editorem, viewer bez prvků, konflikt ve druhé záložce, uncertain (přerušení po odeslání i ztracená odpověď), offline, dokončení/obnovení + Undo, Kdy + Undo, smazání úkolu a poznámky s potvrzením, obnovení seznamů, cs/en, 390/1280 px. Plný `Browser E2E` se kvůli tomuto PR nespouští (jen pro cílený release gate).
