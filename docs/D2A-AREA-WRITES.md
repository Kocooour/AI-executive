# D2a, část 4 — nové zápisy zachovávají normalizaci Oblastí

**Stav: zapsáno a testováno, aplikátor 2a (D2A-AREA-APPLY.md) zůstává NEAKTIVOVÁN.** Cíl: každý NOVÝ zápis (klient i server) vytváří stav, který by planner/aplikátor nemusel opravovat znovu, takže se aplikátor může později spustit jednou a stav zůstane normalizovaný. Jednouživatelský režim; žádný Můj plán, žádný filtr, žádná změna navigace.

## Model

- Projekt má právě jednu Oblast (`belongs_to_area`). Samostatný úkol (bez `belongs_to_project`) má právě jednu Oblast. Úkol v projektu **nemá** vlastní `belongs_to_area` ani `properties.areaId`, Oblast dědí z projektu.
- Výchozí Oblast, když žádná není zvolena: záložní Oblast workspace přesně tak, jak ji pojmenovává a identifikuje planner (`lib/area-normalization.ts`): „Nezařazeno“ (personal) / „Nezařazeno (původní sdílené)“ (legacy sdílený workspace), ID `area:2a:<digest>`. Existuje-li ve workspace **právě jedna** Oblast s tímto normalizovaným popiskem a je aktivní, použije se; jinak se vytvoří deterministická. Nikdy se nevytvoří Oblast, jejíž ID je v tombstones (položka zůstane bez Oblasti a nahlásí ji aplikátor), ani při nejednoznačném/archivovaném popisku.
- `properties.kind` Oblasti vždy odpovídá workspace (personal → `private`, shared → `shared`).
- Vše uvnitř jednoho workspace, nikdy napříč.

## Serverová autorita: `lib/area-write-invariants.ts`

Čistá deterministická funkce `enforceAreaWriteInvariants({ current, next, tombstones, now })`; `current` = uložený stav před zápisem, `next` = stav, který se má uložit. Vrací opravený `next`, ID odstraněných relací (zapisují se jako tombstones) a **report jen s počty** (bez titulků a ID). Zasahuje **jen do změn, které zápis sám přinesl**; staré porušení, kterých se zápis nedotkl, zůstávají (patří auditovanému aplikátoru).

| Pravidlo | Význam |
|---|---|
| R1 | Nová vazba `belongs_to_area` (nebo nově nastavené `properties.areaId`) u úkolu, který je v projektu, se zahodí. |
| R2 | Úkol, který v tomto zápisu získá projekt, přijde o **všechny** vlastní Oblasti a `areaId` (přesun do projektu = dědění). |
| R3 | Nový projekt, nový samostatný úkol nebo úkol, který projekt opustil, a nemá Oblast → záložní Oblast (vytvoří se i s `kind`). Opouštějící úkol dostane záložní, ne Oblast bývalého projektu. |
| R4 | Entita, která získala druhou Oblast: ponechá se nejnovější nová vazba (`createdAt`, pak ID), ostatní nové se zahodí; několik vazeb, které všechny existovaly dřív, je legacy a zůstává. |
| R5 | Oblast nová nebo změněná v zápisu dostane `kind` podle workspace (obnoví také `kind` smazaný starým klientem bez sync base — dřívější „KNOWN GAP“). |

Upravené entity dostanou `updatedAt = max(now, starý + 1)` a tam, kde se změnily vazby, `properties.relationsUpdatedAt` stejně (aby oprava vyhrála i bázi-prosté slučování starého klienta). Funkce je idempotentní (aplikace na vlastní výstup nic nemění) a nezávislá na pořadí vstupu.

Vyvolává ji každá serverová zápisová cesta:

- `replaceSnapshot` (`lib/server-store.ts`, `PUT /api/store`) uvnitř transakce, po sestavení `next` a před `writeSnapshotRows`. Odpověď PUT je uložený (opravený) snímek, který klient převezme (`applySnapshot` v `use-sync.ts`); odstraněná relace je navíc tombstone, takže ji ani starý klient bez báze nevzkřísí (v merge s bází vyhrává odstranění na serveru). Test: `tests/area-write-store.test.mjs` (round trip).
- Inbox batch (`lib/inbox-batch-store.ts`): `organize` bere **projekt, nebo Oblast, nikdy obojí** (`validateInboxBatch` odmítne oboje, 400). Oblast pro dávku, v níž je alespoň jeden úkol už v projektu, **odmítne celou dávku** (`InboxBatchInvalid` → 409) — dávka je atomická a prověřený výběr se použije celý, nebo vůbec; úkoly se tiše nepřeskakují. UI (`inbox-batch-triage.tsx`) takovou kombinaci nenabízí.
- AI akce (`lib/ai-actions.ts`): vytvořený samostatný úkol dostane záložní Oblast, přesun do projektu odstraní vlastní Oblast; záznam historie obsahuje skutečně uložené relace, takže Undo funguje. Undo přesunu do projektu vrací úkol bez projektu → dostane záložní Oblast (původní vlastní Oblast se neobnovuje).
- Další výskyt opakovaného úkolu (`lib/work-sessions.ts`): zachová projekt (Oblast dědí) nebo zkopíruje Oblast samostatného úkolu; samostatný výskyt bez Oblasti dostane záložní.

Server-side helper pro přímé zápisy do SQLite: `lib/area-write-store.ts` (`readAreaRows` před mutací, `enforceAreaWritesInTransaction` po ní, ve stejné transakci).

## Klient (okamžitá konzistence; server zůstává autoritou)

- `lib/area-ids.ts` + `lib/sha256.ts`: prohlížečové (bez `node:crypto`) funkce pro popisky a deterministická ID; byte-for-byte shodné s plannerem (test proti `node:crypto`).
- `lib/area-write-client.ts`: `assignFallbackArea`, `dropTaskAreaLinks`, `taskIsInProject`, `areaKindOf` (v transakci Dexie).
- `lib/db.ts` `migratePropertyRelations`: `properties.areaId` u úkolu v projektu (nebo úkolu, který projekt získá touž migrací) se jen smaže, bez vazby `belongs_to_area` (čisté pravidlo `legacyAreaIdBecomesRelation`).
- `use-lumi-app.tsx`: `create` (Oblast má `kind`; nový projekt i přes `newProjectTitle`, a samostatný úkol bez volby dostanou záložní; úkol v projektu nemá vlastní Oblast), `relate` (připojení k projektu odstraní vlastní Oblasti; odebrání projektu nebo vymazání Oblasti nastaví záložní; Oblast u úkolu v projektu se odmítne výjimkou), `triageInbox`/`triageInboxBatch` (projekt, nebo Oblast, ne obojí), přetažení úkolu na Oblast (přeskočí se u úkolu v projektu).
- UI: detail úkolu v projektu ukazuje „Oblast: <název> (z projektu)“ jen pro čtení; samostatný úkol má výběr Oblasti bez prázdné volby; stránka projektu bez prázdné volby; Inbox triage i dávka zamknou výběr Oblasti, jakmile je zvolen projekt; Quick Capture nabízí jako výchozí položku záložní Oblast a u zachycení přímo v projektu Oblast nenabízí.
- `lib/tools.ts` (`create_entity`), seed ukázkových dat a událost kalendáře → úkol (jde přes `create`) dodržují totéž.

## Záměrné odchylky a hranice

- **ID relace záložní Oblasti.** Planner používá `relation:2a:<digest>`. Zrušená relace má natrvalo tombstone (`R2` ji například odstraní, když úkol vstoupí do projektu), proto by úkol, který projekt později opustí, jinak zůstal bez Oblasti. Zápis proto zkusí deterministicky `relation:2a:…`, a je-li zablokované/obsazené, `relation:2w:<digest>` s počitadlem. ID **Oblasti** zůstává výhradně plannerovo; tombstone na něm položku nechá bez Oblasti.
- Štítek `properties.area` (legacy text) a `properties.projectId` (legacy property) se počítají jako „má Oblast“, resp. „je v projektu“, ve shodě s plannerem; záložní Oblast se v takovém případě nepřidá, aby aplikátor nenarazil na `conflicting-legacy-area-label`.
- Mimo rozsah (nejsou „nové zápisy“): restore/import zálohy, schématické migrace, poznámky a kontextové záznamy, a staré porušení, kterých se zápis nedotkl.
- Server po oprávněném smazání záložní Oblasti (tombstone) další položky nezařazuje; zůstávají bez Oblasti, dokud je nenormalizuje aplikátor / vlastník.

## Doplnění po revizi testery

- **Smazaný projekt.** Úkol je „v projektu“ jen přes `belongs_to_project` nebo `properties.projectId` na **živý** projekt daného snímku. Když zápis způsobí, že projekt úkolu zmizí, odstraní se visící `projectId` a úkol dostane záložní Oblast (R3). Visící `projectId` u úkolů, kterých se zápis netýká, zůstávají (legacy, řeší aplikátor). Klient `remove(projekt)` dělá totéž lokálně.
- **R4** porovnává jen vazby nové v zápisu (nikoli legacy), takže posun hodin neshodí volbu uživatele.
- **Druh workspace** (a tím název záložní Oblasti) se u existujícího workspace bere z **uloženého** záznamu; zápis ho nemůže přepsat. Nový workspace použije vlastní záznam.
- **Relace při přesunu mezi cykly**: hranice pokusů o ID záložní vazby je 1000.
- **Záložní Oblast je systémová.** Klient (`isFallbackArea`) odmítne její přejmenování a smazání a v detailu to vysvětlí. Server to zatím **nevynucuje**: surový PUT, který ji smaže, projde (tombstone pak trvale blokuje 2a preflight `tombstoned-generated-area-id`). Důvod, proč server nic nepřidává: ochrana „ponechat smazanou, dokud na ni odkazují živé položky“ by měnila význam úmyslného smazání a patří do serverové autorizace Oblastí (2b/2c), ne do tohoto kroku.
- **Tombstones na klientovi.** Klient serverové tombstones nedrží (`applySnapshot` je zahazuje), proto je `planFallbackArea` na klientu nedostává. Je to bezpečné: server entitu s tombstonovaným ID zahodí a nahlásí `fallbackUnavailable`.
- **Surový PUT nesmí poslat relaci na smazanou entitu** (400 „Snapshot contains a relation to a missing entity“). Aplikace to řeší v `forServer`; skripty/testy musí relace smazaných záznamů odstranit samy (nové úkoly a projekty mají vazbu na Oblast).
- **Souběh** „nastavit Oblast“ × „přesunout do projektu“ na dvou zařízeních vede k projektu (úkol dědí); nahrazená volba Oblasti zůstane jako značka sync-konfliktu.
- **Undo AI vytvoření** úkolu ponechá vytvořenou (nyní prázdnou) záložní Oblast.
- **Výkon:** zápisové cesty přímo do SQLite (Inbox batch, AI akce, výskyt opakovaného úkolu) čtou celé tabulky entit a relací před i po zápisu. Pro současné objemy stačí; případná optimalizace = čtení jen dotčených řádků.
