# D2b, část 2 — návrh záchrany offline změn před partition

**Stav: pouze knihovní kontrakt a regresní testy, žádné přepnutí runtime cesty.** Navazuje na read-only audit PR #110. Cílem je připravit bezpečný formát pro předání rozpracované práce vlastníka při rozdílu `restoreGeneration` před budoucím 2b rozdělením shared workspaces.

## Existující problém

Server již odmítá zápisy ze staré generace (`409 code:restored`) a obdobnou ochranu používají ostatní owner-writes. Ale `adoptServerCopy()` v `app/ui/hooks/use-sync.ts` dnes po přijetí odpovědi obnovy přepíše lokální Dexie kopii, staré sync markery i poznámkové a projektové drafty. To je správné proti návratu zastaralých dat po běžném restore, **ale nestačí pro 2b migraci**, která vyžaduje zachovat offline práci pro explicitní export a individuální rekonsiliaci. **Na produkčním serveru proto 2b zatím nespouštět.**

## Co implementuje tato iterace

- `lib/d2b-offline-reconciliation.ts` nabízí `prepareOfflineRecovery(input, now)`. Je to čistá deterministická funkce: ze známé společné `base` a lokální verze vybere **jen změněné/nové/smazané entity a relace**; připojí pending deletion/revival marker IDs a obě sady per-tab rozepsaných draftů. Zahrne původní i místní podobu každé změny. Neposílá nic přes síť, nemanipuluje s browser storage ani nevytvoří soubor sama.
- Balíček deklaruje `format: lumi-d2b-offline-recovery`, `version:1`, `sensitiveOwnerData:true`, `automaticReplayAllowed:false` a obsahuje generation/revision. Výstup je soukromý: může obsahovat texty úkolů a poznámek, a proto **se nesmí logovat, poslat do AI, uložit do veřejné cache, do URL nebo exportovat bez vědomého rozhodnutí vlastníka**.
- `assessOfflineRecovery(bundle, currentServer)` kontroluje integritu obsahu (SHA-256 pouze proti náhodné změně, **ne autentizace ani podpis**) a vrací důvody k ruční rekonsiliaci, např. `workspace-changed`, `remote-diverged`, `remote-missing`, `id-collision` (nový lokální záznam s kolidujícím serverovým ID) a `already-deleted` (lokální smazání již odpovídá serveru). Kontrolují se **entity i relace** a společný ID namespace napříč jejich typy na base/local snapshotu. **Nepovoluje žádný automatický replay**; po 2b změně oprávnění musí ještě samostatná autorizační vrstva zkontrolovat cílovou Oblast a aktéra.
- Regresní testy ověřují, že nezmizí lokální smazání, oživení ani drafty, že export neobsahuje nezměněné entity, že pořadí zdrojových polí nemění deterministický výsledek, že balíček není ovlivněný pozdější změnou vstupního objektu a že konfliktní/poškozené balíčky nejsou přijaty.
- **Import balíčku v1 ověřuje strukturu nezávisle na SHA-256**: každý diff musí obsahovat právě ID, `before`, `after`, alespoň jednu nenulovou podobu a shodná ID ve vnořených záznamech; chybné typy, duplicity a průnik ID entit/relací jsou odmítnuty. Validují se také generace, markerové seznamy, zákaz současného smazání a obnovení stejného ID, `pendingSync`, obě pole draftů a jejich limity. I JSON s úmyslně přepočteným platným hashem může být neplatný — výsledek je vždy `OfflineRecoveryInvalid`, nikdy automatické přehrání nebo pouhý zavádějící kandidát.

## Bezpečnostní limity diagnostiky

Čistá synchronní implementace `prepareOfflineRecovery` a `assessOfflineRecovery` je **fail-closed**. Při překročení limitu odmítne celý balíček jako `OfflineRecoveryInvalid`; žádný záznam, draft ani marker se **nezkracuje, neodstraňuje a nezapisuje zpět**. Limity jsou definovány v `offlineRecoveryLimits`:

| Prvek | Limit |
| --- | ---: |
| Entity na snapshot (base nebo local) | 20 000 |
| Relace na snapshot (base nebo local) | 50 000 |
| Pending smazání/obnovení každého typu | 20 000 |
| Návrhy poznámek a kontextu každého typu | 512 |
| Jednotlivý draft po serializaci (JSON znaky) | 128 Ki znaků |
| Jednotlivý textový řetězec | 256 Ki znaků |
| Součet textových znaků ve validovaných vstupních snímcích a draftech | 32 Mi znaků |
| Navštívené hodnoty/klíče při každé validaci | 500 000 |
| Hloubka vnoření | 32 |
| Celý vytvořený/ověřovaný balíček bez hashe (JSON znaky) | 8 Mi znaků |

Toto jsou **limity počtu znaků**, nikoliv garantovaný limit počtu bytů UTF-8; pro skutečný export do souboru musí následná UI iterace uplatnit ještě bytový limit a vědomé potvrzení vlastníka. Synchronní průchod probíhá jen nad rozsahem, který prošel předběžnou kontrolou počtů; před přidáním na pre-adoption cestu je nutné ověřit latenci a případně přesunout těžkou práci mimo hlavní UI vlákno. Překročení znamená **stop a zachování lokálních dat**, nikoli automatickou adopci.

## Co to zatím záměrně NEřeší

1. **UI a uložení/předání:** vlastník zatím nemá v aplikaci tlačítko pro lokální export nebo zobrazení konfliktů. Tato knihovna není připojená do `useSync`, nesmí být interpretována jako zprovozněná ochrana offline fronty.
2. **Předadopční fail-closed kontrola:** `adoptServerCopy()` zůstává zatím nezměněno. Je třeba před jakýmkoliv budoucím zvýšením generace pro 2b nejprve integrovat kontrolu pending markerů a draftů a UI možnost ověřeného exportu **před destruktivní adopcí**, včetně souběhu více panelů a pádu/tab reloadu.
3. **Rozhodnutí o obsahu:** žádná data ze starého sdíleného workspace se automaticky nepřekládají do nové cílové Oblasti; změna identity nebo ACL musí zůstat fail-closed.
4. **Auditovaný transakční migrátor 2b** s atomickým bumpem `restoreGeneration`, zálohou a rollbackem stále neexistuje. Produkční 2a, offline bezpečnostní brána, navázaná tabulková matice, 2c assignee backfill a D3 zapnutí jsou nezávislé a stále čekají.

Tento PR tedy pouze definuje a testuje **kontrakt** offline obnovy. Neprovádí migraci, nemění sync protokol ani možnost sdílení. Full browser E2E je až před nasazením přesně otestovaného main SHA, ne pro každý PR.
