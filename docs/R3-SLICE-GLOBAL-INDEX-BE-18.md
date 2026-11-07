# R3 / BE-18 — životní cyklus autorizovaného čtení globálního indexu

Tato iterace navazuje na [BE-16](R3-SLICE-GLOBAL-INDEX-BE-16.md) (read-only HTTP klient) a [BE-17](R3-SLICE-GLOBAL-INDEX-BE-17.md) (neprůhledné kurzory a více stránek). Přidává **pouze paměťový, opt-in řadič explicitních GET** `createGlobalIndexReadSession` pro budoucí společné UI-09/R3 propojení globálního **Vše / Osobní / Sdílené**. Globální `all` není osobní **Můj plán**.

## Kontrakt

- Volající předá `scope`, `limit` (1–100) a povinný `contextVersion:()=>string`: **nesekretní monotonicky měněnou generaci** klientské autentizační relace. Při přihlášení, odhlášení, přepnutí účtu nebo invalidaci klientské autorizace musí aplikace generaci změnit. Nepředává se do HTTP requestu; žádné actor ID, role, Area, credential ani číslo revize serveru.
- `getSnapshot()` vrací obsah pouze v `ready`. Při `loading` (i při načítání další stránky) nejsou vráceny žádné staré tituly. Při změně generace se uložený řetězec okamžitě uvolní a další operace vrací `stale`, **trvale pro danou instanci** (i při chybné opakované hodnotě generace A → B → A); je nutné vytvořit novou instanci. Výsledky i snapshoty jsou oddělenými kopiemi položek, aby je UI nemohlo mutovat a změnit interní kurzor.
- `loadFirst()` a `loadMore()` vyžadují **výslovné volání**. Nic se nestahuje v konstruktoru, při změně události ani automaticky. Každý GET zůstává `same-origin/no-store`, bez retry, cache, prefetchu a zápisů. Paralelní pokus o `loadMore` vrátí `busy`; nový `loadFirst` zruší předešlý a používá pořadové číslo požadavku proti opožděné odpovědi.
- `dispose()` přeruší aktivní fetch a vyprázdní paměť řadiče. Při změně generace, `401`, `409`, offline, abortu, chybném DTO, opakovaném kurzoru nebo jiné chybě se vrací chybový stav **bez jakýchkoli dříve načtených titulů**.
- Skutečnou identitu, Area ACL, revokaci členství, podepsané kurzory i aktuálnost dat dál **výhradně ověřuje server** na každém GET. Klientská `contextVersion` není autorita ani autentizační token; nemůže zaručit okamžité smazání výsledků, které si externí UI samo zkopírovalo či vykreslilo. Volající musí staré reference při změně relace zahodit a reagovat na její autentizační události.

## Testy a omezení

`tests/target-staging-global-index-read-session-be18.test.mjs` má 13 cílených regresí: výslovné načítání tří stránek, copy-out snapshoty, zablokované duplicitní požadavky, zneplatnění při změně, chybě i opakovaném návratu generace (A → B → A), odmítnuté parametry bez GET, přerušené a pozdě došlé odpovědi při novém startu/dispose, změna identity u pokračování, fail-closed 401/409/offline/DTO, cyklus kurzoru a odmítnutý cizí scope.

Tento headless řadič je **záměrně oddělen od souběžného UI-09a / PR #308**, které má vlastní stagingový náhled a nezávislý UI životní cyklus. BE-18 tento náhled nemění ani jej nepřipojuje k produkční navigaci. Následná UI integrace musí explicitně rozhodnout o sjednocení/použití řadiče a bezpečném zahození externích React stavů.

Staging-only, default OFF. Bez změn serverového API, serverových oprávnění, SQL, databáze, identity, migrace, produkčního UI, synchronizace nebo nasazení. Kompletní Browser E2E patří až do přesně SHA-přiřazené brány před produkčním nasazením.
