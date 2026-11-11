# R3-CAPTURE-2 — soukromá poznámka: skutečný zápis a ověření výsledku

**Milník:** [R3-CAPTURE](R3-CAPTURE-PRIVATE-AREAS.md). Tento PR je druhá iterace ze 3 plánovaných. Je to skutečná integrace cílového Notes UI a již existujícího transakčního stagingového zapisovače, **výchozí nastavení všech nových UI/HTTP bran je vypnuto**. Neznamená povolení produkčního zápisu nebo R4.

## Akceptace

Ve skutečné cílové obrazovce **Poznámky** uživatel po čerstvém autorizovaném výběru právě jedné **soukromé zapisovatelné** Oblasti zadá název a text, potvrdí jediný `POST /api/target-staging/notes` a vidí výsledek až po potvrzení z backendu. Po úspěchu se znovu načte autorizovaný Notes seznam. Žádná volba není předvybraná; sdílená ani cizí Oblast se nenabídne a server ji při zápisu odmítne. V UI zůstává při vypnuté create bráně původní read-only náhled, který nikdy nezapisuje.

**Ztracená odpověď, timeout, obnovení stránky a odmountování dialogu:** než se pošle jediný CREATE, uloží se do `sessionStorage` této záložky pouze přesně `{generation,commandId}` (ne noteId, Area, text, titul, ACL nebo token). Timeout i nejednoznačné HTTP odmítnutí vedou k `uncertain`, nikoliv k úspěchu. Nový příkaz se nezahajuje, dokud server read-only neprokáže `committed` pro stejný příkaz a současnou identitu/Area. `not_recorded` není důkaz neprovedení a **nesmí** odstranit bariéru; změna přihlášení ani autentizační generace bariéru **nesmí odstranit**; jen aktuálním aktérem serverově potvrzený `committed` pro stejný příkaz smí marker odblokovat i po nové session; nedochází k automatickému opakování ani k náhradnímu UUID. Výsledek `201` nebo přesné idempotentní `200` od stejného POST může bariéru uvolnit i po zavření dialogu, protože pending příkaz vlastní runtime, nikoliv dialog. Výpadek úložiště prohlížeče zablokuje zahájení zápisu.

## API

- `POST /api/target-staging/notes/create-preview` — **jen čte**. Body přesně `{areaId}`, bez Query, stejného původu, s `x-lumi-target-protocol: 1`. Vyžaduje standardní write/create i nezávislou private Area read bránu. V připnutém snapshotu ověří skutečnou autorizovanou soukromou Oblast a **živé** revizní witness každé Oblasti; vydá pouze `{restoreGeneration}`. Není to write lease. Zapisovač při INSERT vše znovu atomicky ověřuje.
- `POST /api/target-staging/notes` — existující idempotentní jediný private standalone CREATE; žádné změny jeho autorizace nebo scope. Body přesně `{noteId,commandId,areaId,restoreGeneration,title,body}`, server nepřijímá `projectId` ani workspace a vrací jen content-free `{ok,noteId,replayed?}`.
- `POST /api/target-staging/notes/create-recovery` — **jen čte**, body přesně `{commandId}`. Ověří podepsaného aktuálního writera, pinned read-only snapshot, nepodvržitelný lifecycle receipt, aktuální soukromý parentless note/Area write ACL a aktivní restore. Před odpovědí HTTP znovu ověří živé session a detailní Area/policy guard. Navenek jen `{status:"committed"|"not_recorded"}`, bez note ID, obsahu, owner ID a důkazů ACL. Chybějící receipt nedokazuje bezpečnost nového zápisu; přístup odepřený po vytvoření neprozradí ani potvrzení.
- `AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_CREATE_ENABLED=true` je **samostatná UI brána** navíc k `HTTP_WRITE_ENABLED`, `HTTP_NOTES_WRITE_ENABLED`, `HTTP_NOTES_CREATE_ENABLED`, stávajícímu default-off cílovému Notes UI a `HTTP_PRIVATE_NOTE_AREAS_ENABLED`. Samotný read-only výběr Obrastí žádnou write bránu nezapíná.

## Ověření

- **Reálné HTTP + SQLite:** rozšířené `tests/target-staging-note-create-http.test.mjs`: owner i durable writer, cizí a sdílené Oblasti, úspěšný CREATE a potvrzení přes čistý UUID, anonymní/odvolaná session, dosud neexistující receipt, zakázané flagy, špatné protokoly/těla a důkaz, že potvrzovací response neobsahuje text.
- **Transport a bariéra:** `tests/target-private-note-create-client.test.mjs` testuje přesnou JSON strukturu, odmítání content-injection, absence citlivých údajů ve storage, zamezení nového UUID při nejistém výsledku a pozitivní dokončení i po unmountu.
- **Cílený Chromium 390 px a 1280 px:** `e2e/target-private-note-create.spec.ts` ověřuje skutečný hlavní React UI tok se syntetickými HTTP odpověďmi pro úspěch, nejistotu/reload/receipt, unmount a revokaci. Samostatný isolated Playwright server na portu **3122** s `LUMI_PRIVATE_NOTE_CREATE_E2E=true`, oddělený od read-only Area preview a všech skutečných dat. Nejde o kompletní preprodukční Browser E2E.

## Nedokončené a výslovně blokované

Tato iterace zapojuje vytvoření z **cílové obrazovky Poznámky**. Není to ještě sjednocená globální plovoucí Quick Capture akce dostupná z každé obrazovky; ta spolu s UX přístupností, offline konceptem a prokázanou skutečnou navigací BFCache patří do **R3-CAPTURE-3**, posledního PR plánovaného milníku. Po nejednoznačném, ale nikdy nezaznamenaném zápisu může záložka zůstat bezpečně blokovaná; v této iteraci není žádné automatické vynucené odblokování, které by mohlo duplicitně vytvořit poznámku. Časově omezené vypnutí markeru **není** povoleno bez nového serverového důkazu.

Hlas, sdílené poznámky, projekty a úkoly se netvoří. **Nenasazovat** bez kompletního release E2E na přesném produkčním SHA, ověřené zálohy/obnovy a samostatného schválení R4 cutoveru.
