# Lumi — aktuální roadmapa vývoje

**Aktualizováno 2026-10-26.** Primární návaznost: [rozhodnutí o čistém startu](decisions/2026-10-26-cisty-start-d3.md), [produktový kontrakt LUMI-FR-013](PRODUCT.md#lumi-fr-013), [technické bezpečnostní hranice](ARCHITECTURE.md).

## Kde jsme

| Oblast | Ověřený stav k rozhodnutí | Význam pro nový plán |
|---|---|---|
| D2a | Normalizační aplikátor a invarianty nových zápisů jsou připravené; aplikátor není produkčně spuštěný | **Znovu využít invarianty**; historickou normalizaci nevyžadovat při čistém startu |
| D2b | Diagnostika rozdělení a ochrana offline změn existují, dělení starého obsahu není spuštěné | Nepokračovat v zachování legacy workspace rozložení; zachovat bezpečné pravidlo invalidace starých klientů |
| D2c | Syntetické preflight/postcheck kontroly legacy řešitelství jsou rozpracované | Nenavazovat další migrační diagnostikou; u nového modelu řešitelství nastavit přímo |
| D3 | Čtecí selektor `Můj plán / Osobní / Sdílené` (#103) a přepínač (#108) byly sloučeny, ale **nejsou aktivované v aplikaci** | Propojit je s autorizovaným read modelem po dokončení bezpečnostních bran |

Stav přípravných nástrojů není stav produkční aktivace.

## Nová kritická cesta

| Milník | Priorita | Dodávka | Hotovo, když |
|---|---|---|---|
| **R0 — Uzavřít legacy migrační větev** | P0 | Zdokumentovat clean-start rozhodnutí, zrevidovat D3 aktivační brány, zachovat dřívější testy, inventarizovat data, cache, zařízení a externí integrace bez změny provozu | Legacy backfill 2a–2c již není předpokladem D3; seznam zachovávaných vs. případně zahazovaných údajů je výslovně sestaven |
| **R1 — Cílový model na odděleném úložišti** | P0 | Nedestruktivní bootstrap nové prázdné DB/stagingu se dvěma uživatelskými prostory, přesnými Oblastmi a děděním; `assigneeUserId` v novém modelu; validace všech zápisových cest | Testy invariantu jedné Oblasti, bezpečného soukromého `Nezařazeno`, žádných implicitních publikací a stabilních ID procházejí; stávající DB zůstává nedotčena |
| **R2 — Identity, serverová ACL a sync** | P0 | Aktér v sessions/token/API, serverové filtrování čtení a per-item autorizované zápisy, user-scoped cache/stav, verze sync protokolu, fail-closed obnova/revokace; starý full-snapshot klient nesmí zapsat do nové generace | Syntetická matice 2–3 identit pro čtení/zápis/AI/search/počty/notifikace/export projde; žádný cross-Area únik ani oživení starých dat |
| **R3 — Aktivovat připravené D3** | P1 | Připojit #103/#108 do desktopového a mobilního UI; výchozí `Můj plán` jako datový rozsah pro Home, Inbox, Today, Upcoming, Projects, search a attention; zápisy jen do konkrétní Oblasti | Tři pohledy vracejí správné autorizované položky, nepřidělené sdílené úkoly zůstávají ve Sdílené; Home je úvodní obrazovka; mobilní přístupnost a offline scénáře ověřeny |
| **R4 — Bezpečný cutover a release** | P1 | Operátorský plán přepnutí do cílového úložiště, archivní záloha, ověřený restore, upgrade/zneplatnění starých Dexie klientů, feature gates, smoke testy | **Výslovný separátní souhlas před resetem**, testy a kompletní Browser E2E release gate na přesném SHA, pak teprve případné produkční nasazení |
| **R5 — Rozšíření spolupráce a asistence** | P1/P2 | Pozvánky a správa členů teprve po auditované ACL/revokační bráně; per-user plánování/push; další osobní mail/kalendářové integrace a proaktivní funkce | Sdílení nikdy nepřekročí práva Oblasti a soukromý zdroj se nezveřejní bez konkrétního potvrzení |

R1–R3 lze vyvíjet a testovat izolovaně před jakýmkoli produkčním přepnutím. R3 nesmí aktivovat skutečné víceuživatelské sdílení bez všech potřebných částí R2 a příslušné části R5.

## Neobejitelné bezpečnostní brány

- Žádné destruktivní operace bez **nového, konkrétního souhlasu**. Souhlas se zjednodušením migrace není souhlas se smazáním dat.
- Před cutoverem inventura živých databázových záznamů, přihlašování/passkeys, integračních tokenů a nastavení, mailu, kalendáře, kontextu, pozornosti, push, záloh, klientských Dexie cache, offline front a dalších připojených zařízení. Zachovat vše neoznačené výslovně jako postradatelné.
- Ověřená konzistentní archivní záloha **včetně potřebných souvisejících údajů** a zkouška obnovy; čistý start nesmí vypnout běžné zálohy ani rollback.
- Oddělit nový datový prostor a synchronizační generaci od staré. Stará offline fronta nesmí vložit znovu obsah, přepsat nová oprávnění ani být potichu zahozená; nevyřešený stav blokuje přepnutí a vyžaduje rozhodnutí o exportu/odmítnutí.
- Server vždy kontroluje **identitu, Oblast, roli, revizi a konkrétní cílovou Oblast zápisu**. Klientský filtr ani přepínač není ACL. Soukromé `Nezařazeno` je bezpečný default; zveřejnění vyžaduje potvrzení.
- Všechny PR mají standardní PR Checks a review; **úplné browser E2E výhradně jako release gate bezprostředně před produkčním deployem** podle [AGENTS.md](../AGENTS.md). Žádné změny produkčních dat, přepínání flagů či nasazení nejsou součástí této změny plánu.

## Co se odsouvá mimo kritickou cestu

Těžký převod historických `workspaceId`, perfektní zachování ID/tombstonů/pořadí starých testovacích úkolů, staré `owner` assignee backfilly, matice před/po legacy Home/Today/Inbox a detailní reconciliace testovacích obsahů. Dosavadní kód a testy se **nemažou**. Pokud se později ukáže skutečně hodnotný záznam, převede se cíleně pouze na základě samostatného schválení; nikdy automatickou publikací do Sdíleného.

**Další implementační iterace:** R1 — návrh a nedestruktivní bootstrap cílového modelu v izolovaném prostředí, souběžně s návrhem R2 serverových ACL. Není to příkaz k produkčnímu resetu.
