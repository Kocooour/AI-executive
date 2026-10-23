# D3 — příprava datového rozsahu „Můj plán“

Stav: **přípravná implementace, bez aktivace v UI**. Navazuje na schválený kontrakt [LUMI-FR-013](PRODUCT.md#lumi-fr-013) a migrační plán v [ARCHITECTURE.md](ARCHITECTURE.md#víceuživatelské-oblasti--cílový-bezpečnostní-kontrakt-2026-10-23).

## Co obsahuje první D3 změna

- `lib/work-read-scope.ts`: deterministický, bezstavový čtecí selektor pro `my-plan / personal / shared`.
- **Můj plán:** soukromé úkoly a pouze výslovně mně přiřazené sdílené úkoly, včetně dokončených úkolů pro dokončené přehledy; v Projects soukromé projekty a společné projekty s mým otevřeným úkolem.
- **Osobní:** všechny moje soukromé úkoly a projekty. **Sdílené:** všechna serverem autorizovaná sdílená práce včetně nepřidělené a cizí práce.
- Výstup neklonuje ani neupravuje úkol, projekt, ID, časové značky ani workspace; náhled projektu není autorizací detailu. Neplatné/cizí workspace relace se ignorují, konfliktní kanonické ID vyvolá chybu.
- Selektor **není autorizační vrstva**. Parametry identita a `authorizedSharedWorkspaceIds` musí v budoucnu poskytovat ověřený server, ne volba klienta či obsah entity.

## Před aktivací v UI (blokující požadavky)

1. Normalizace povinných Oblastí 2a.
2. Auditované rozdělení sdílených interních workspaces podle Oblastí 2b, včetně synchronizační bariéry, záchrany offline změn a bezpečného rollbacku.
3. `assigneeUserId` a deterministic backfill otevřených původních sdílených úkolů dosavadnímu `owner` (2c). Kontrola, že Home, Today, Inbox ani seznamy nepřišly o původní úkoly.
4. Skutečný serverově autorizovaný zdroj všech čtených Oblastí, funkční oddělení osobních údajů a verzování syncu. Přepnutí UI není oprávněním.
5. Následně připojit scope switcher v desktopu a mobilu a všechny výpisy Home/Inbox/Today/Upcoming/Projects/counts/search/attention k bezpečnému read-modelu. Home musí zůstat úvodem. Zápisy vždy cílí na jednu konkrétní Oblast, nikoliv agregát.
6. Testovat prázdné stavy, konzistenci ID/revizí napříč scope, projektový detail se všemi autorizovanými úkoly, klávesnici/VoiceOver/mobil, ztrátu práv, offline a konflikt.

**Nezahrnuto v této změně:** migrace, assignee zápisy, oprávnění více identit, nové pozvánky, úprava současného workspace switcheru, aktivace Mého plánu, nasazení.

Browser E2E celá sada zůstává výhradně release gate před nasazením dle `AGENTS.md`; zde se používá běžné PR CI.
