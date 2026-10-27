# D3 — příprava datového rozsahu „Můj plán“

Stav: **přípravná implementace, bez aktivace v UI**. Navazuje na schválený kontrakt [LUMI-FR-013](PRODUCT.md#lumi-fr-013) a aktuální [clean-start roadmapu](ROADMAP.md) s povinnými bezpečnostními branami v [ARCHITECTURE.md](ARCHITECTURE.md). Historický migrační plán platí pouze při schváleném převodu legacy dat.

## Implementační checkpoint 2026-10-27

Podle aktuální [roadmapy](ROADMAP.md) je **R1 staging základ hotový** (PR #127–130), **R2 rozpracované**: PR #131–134 doplnily staging autentizované čtení, kontrolu read-only SQLite snapshotu, process-local session/revokaci a session-bound stránkování. [PR #135](https://github.com/Kocooour/AI-executive/pull/135) je rozpracovaný **read-only preflight** budoucího zápisu; žádný skutečný task mutation endpoint neexistuje.

**Nejde o aktivované D3 ani produkční serverová oprávnění.** Staging identita není totožná s přihlášením Lumi; stávající Home/Inbox/Today/Projects/search/attention stále nejsou napojené na nový autorizovaný read model. Další pořadí: dokončit #135 → transakční per-item příkaz a identity-bound server API → sync/revokační brána a plné autorizované výpisy → potom integrace D3 do UI. Celé Browser E2E zůstává výhradně předprodukční release gate.

## Co obsahuje první D3 změna

- `lib/work-read-scope.ts`: deterministický, bezstavový čtecí selektor pro `my-plan / personal / shared`.
- **Můj plán:** soukromé úkoly a pouze výslovně mně přiřazené sdílené úkoly, včetně dokončených úkolů pro dokončené přehledy; v Projects soukromé projekty a společné projekty s mým otevřeným úkolem.
- **Osobní:** všechny moje soukromé úkoly a projekty. **Sdílené:** všechna serverem autorizovaná sdílená práce včetně nepřidělené a cizí práce.
- Výstup neklonuje ani neupravuje úkol, projekt, ID, časové značky ani workspace; náhled projektu není autorizací detailu. Neplatné/cizí workspace relace se ignorují, konfliktní kanonické ID vyvolá chybu.
- Selektor **není autorizační vrstva**. Parametry identita a `authorizedSharedWorkspaceIds` musí v budoucnu poskytovat ověřený server, ne volba klienta či obsah entity.

## Před aktivací v UI — aktuální clean-start brány (2026-10-26)

Aktuální [roadmapa](ROADMAP.md) zvolila pro převážně testovací data **čistý start cílového modelu** místo povinné legacy migrace 2a–2c. Připravený selektor a přepínač zůstávají neaktivní do splnění bezpečnostních podmínek:

1. Nedestruktivně vytvořit cílový **oddělený store** s platnými Oblastmi, děděním a `assigneeUserId` pro nové sdílené úkoly. Staré 2a normalizace/2b partition/2c owner-backfill nejsou nutné, **pokud stará data nepřenášíme**.
2. Skutečná identita na serveru, příslušnost Oblastí a členství, filtrované autorizované čtení na Home/Inbox/Today/Upcoming/Projects/search/counts/attention/AI; `selectScopedWork` není autorizační vrstva.
3. Nový bezpečný protokol zápisů do explicitní Oblasti, zneplatnění starých full-snapshot klientů, revokační a offline pravidla; ochrana osobních dat v cache a při změně identity.
4. Teprve potom připojit desktopový a mobilní scope switcher; Home zůstane úvodní obrazovka a `Můj plán` agregovaným čtecím rozsahem, nikoli právem zápisu.
5. Testovat izolaci více identit, nepřidělené vs. přidělené sdílené úkoly, prázdné stavy, konzistenci ID/revizí, detail oprávněného projektu, klávesnici/VoiceOver/úzký mobil, ztrátu práv, offline klienty a konflikty. Pozvánky pro další identity zůstávají vypnuté, dokud nejsou splněny všechny bezpečnostní brány.
6. Produkční přepnutí do nového store **není tímto rozhodnutím povoleno**. Vyžaduje inventuru, ověřenou archivní zálohu + obnovu, plán pro staré klienty a samostatný výslovný souhlas vlastníka s přesným rozsahem změn.

**Alternativa:** pokud bude dodatečně rozhodnuto zachovat legacy obsah, teprve pak platí dřívější [migrace 2a–2c](ARCHITECTURE.md#historicka-migrace-2a-2c) včetně backfillu starých úkolů a shody Home/Today/Inbox; nelze ji implicitně obejít při převodu skutečných dat.

**Nezahrnuto v této změně:** migrace, assignee zápisy, oprávnění více identit, nové pozvánky, úprava současného workspace switcheru, aktivace Mého plánu, nasazení.

Browser E2E celá sada zůstává výhradně release gate před nasazením dle `AGENTS.md`; zde se používá běžné PR CI.
