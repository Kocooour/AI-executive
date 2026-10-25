# D2b, část 2 — návrh záchrany offline změn před partition

**Stav: pouze knihovní kontrakt a regresní testy, žádné přepnutí runtime cesty.** Navazuje na read-only audit PR #110. Cílem je připravit bezpečný formát pro předání rozpracované práce vlastníka při rozdílu `restoreGeneration` před budoucím 2b rozdělením shared workspaces.

## Existující problém

Server již odmítá zápisy ze staré generace (`409 code:restored`) a obdobnou ochranu používají ostatní owner-writes. Ale `adoptServerCopy()` v `app/ui/hooks/use-sync.ts` dnes po přijetí odpovědi obnovy přepíše lokální Dexie kopii, staré sync markery i poznámkové a projektové drafty. To je správné proti návratu zastaralých dat po běžném restore, **ale nestačí pro 2b migraci**, která vyžaduje zachovat offline práci pro explicitní export a individuální rekonsiliaci. **Na produkčním serveru proto 2b zatím nespouštět.**

## Co implementuje tato iterace

- `lib/d2b-offline-reconciliation.ts` nabízí `prepareOfflineRecovery(input, now)`. Je to čistá deterministická funkce: ze známé společné `base` a lokální verze vybere **jen změněné/nové/smazané entity a relace**; připojí pending deletion/revival marker IDs a obě sady per-tab rozepsaných draftů. Zahrne původní i místní podobu každé změny. Neposílá nic přes síť, nemanipuluje s browser storage ani nevytvoří soubor sama.
- Balíček deklaruje `format: lumi-d2b-offline-recovery`, `version:1`, `sensitiveOwnerData:true`, `automaticReplayAllowed:false` a obsahuje generation/revision. Výstup je soukromý: může obsahovat texty úkolů a poznámek, a proto **se nesmí logovat, poslat do AI, uložit do veřejné cache, do URL nebo exportovat bez vědomého rozhodnutí vlastníka**.
- `assessOfflineRecovery(bundle, currentServer)` kontroluje integritu obsahu (SHA-256 pouze proti náhodné změně, **ne autentizace ani podpis**) a vrací důvody k ruční rekonsiliaci, např. `workspace-changed`, `remote-diverged`, `remote-missing`. **Nepovoluje žádný automatický replay**; po 2b změně oprávnění musí ještě samostatná autorizační vrstva zkontrolovat cílovou Oblast a aktéra.
- Regresní testy ověřují, že nezmizí lokální smazání, oživení ani drafty, že export neobsahuje nezměněné entity, že pořadí zdrojových polí nemění deterministický výsledek, že balíček není ovlivněný pozdější změnou vstupního objektu a že konfliktní/poškozené balíčky nejsou přijaty.

## Co to zatím záměrně NEřeší

1. **UI a uložení/předání:** vlastník zatím nemá v aplikaci tlačítko pro lokální export nebo zobrazení konfliktů. Tato knihovna není připojená do `useSync`, nesmí být interpretována jako zprovozněná ochrana offline fronty.
2. **Předadopční fail-closed kontrola:** `adoptServerCopy()` zůstává zatím nezměněno. Je třeba před jakýmkoliv budoucím zvýšením generace pro 2b nejprve integrovat kontrolu pending markerů a draftů a UI možnost ověřeného exportu **před destruktivní adopcí**, včetně souběhu více panelů a pádu/tab reloadu.
3. **Rozhodnutí o obsahu:** žádná data ze starého sdíleného workspace se automaticky nepřekládají do nové cílové Oblasti; změna identity nebo ACL musí zůstat fail-closed.
4. **Auditovaný transakční migrátor 2b** s atomickým bumpem `restoreGeneration`, zálohou a rollbackem stále neexistuje. Produkční 2a, offline bezpečnostní brána, navázaná tabulková matice, 2c assignee backfill a D3 zapnutí jsou nezávislé a stále čekají.

Tento PR tedy pouze definuje a testuje **kontrakt** offline obnovy. Neprovádí migraci, nemění sync protokol ani možnost sdílení. Full browser E2E je až před nasazením přesně otestovaného main SHA, ne pro každý PR.
