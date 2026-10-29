# Lumi — aktuální roadmapa vývoje

**Aktualizováno 2026-10-29 po dokončení iterace R2-ID (#152–#158) a rozpracování R2c.** Schválený směr: [čistý start cílového modelu](decisions/2026-10-26-cisty-start-d3.md) podle [LUMI-FR-013](PRODUCT.md#lumi-fr-013). Bez autorizace resetu stávajících dat. Tato roadmapa eviduje **skutečný stav implementace**, nikoli pouze existence knihoven nebo testovacích komponent.

## Aktuální pozice

**Pracujeme na R2 — identita, serverová autorizace, zápisy a bezpečná synchronizace.** Izolovaný model R1 je připravený pro staging; zatím **není zapojen do běžících API, UI ani produkční databáze**. Připravená D3 logika a navigace nejsou aktivované.

| Milník | Stav k 2026-10-29 | Výsledek / zbývající brána |
|---|---|---|
| **R0 — Změna strategie** | **Dokumentační rozhodnutí hotové** (#126) | Legacy migrace 2a–2c nejsou blokátorem čistého startu. Inventura skutečných dat, zařízení a integrací zůstává povinnou částí **R4 před cutoverem**. |
| **R1 — Izolovaný cílový datový model** | **Staging základ implementován** (#127–130) | Nový SQLite bootstrap, read-only kontrola konzistence, Area policy a `my-plan/personal/shared` task read model. Je to testovací vrstva, nikoli dokončená produkční integrace. |
| **R2 — Identity, ACL, zápisy a sync** | **Probíhá** (#131–158 sloučeny) | Iterace **R2-ID je dokončena** na izolovaném stagingu (výchozí vypnuté příznaky): trvalé sessions a víceprocesová revokace (#152), idempotentní příkaz členství (#153), čtení `Sdílené` / `Můj plán` s linearizační kontrolou členství (#154, #156), cursor revize indexované podle Oblastí (#157) a změna názvu sdíleného úkolu podle role (#158). **Další iterace je R2c** (synchronizační protokol cílového modelu a identity-scoped klientská cache). R2d (autorizované agregace) zůstává otevřené. |
| **R3 — Aktivace D3** | **Připraveno, neaktivováno** | Čtecí selektor #103 a přepínač #108 existují, nejsou bezpečně propojené se serverovou aplikací. |
| **R4 — Cutover a release** | **Nespouštěno** | Vyžaduje dokončené bezpečnostní brány, inventuru, ověřenou archivní zálohu/restore a **samostatný výslovný souhlas** s přesným rozsahem případného resetu. |
| **R5 — Rozšířená spolupráce a asistence** | **Navazující vývoj** | Pozvánky, víceuživatelské sdílení a rozšířené integrace až po úplném identity/ACL/sync/revokačním kontraktu. |

### Ověřený postup na PR

| PR | Stav | Co přineslo |
|---|---|---|
| [#126](https://github.com/Kocooour/AI-executive/pull/126) | Sloučeno | Rozhodnutí o čistém startu a první roadmapa |
| [#127](https://github.com/Kocooour/AI-executive/pull/127) – [#130](https://github.com/Kocooour/AI-executive/pull/130) | Sloučeno | Izolované SQLite schéma, bezpečnostní preflight, Area role a filtrování úkolů |
| [#131](https://github.com/Kocooour/AI-executive/pull/131) | Sloučeno | Ověřování aktéra při staging čtení |
| [#132](https://github.com/Kocooour/AI-executive/pull/132) | Sloučeno | Autorizované čtení nad validovaným privátním read-only SQLite snapshotem |
| [#133](https://github.com/Kocooour/AI-executive/pull/133) | Sloučeno | Dočasné staging sessions a okamžité lokální (process-local) odvolání |
| [#134](https://github.com/Kocooour/AI-executive/pull/134) | Sloučeno | Session-bound stránkovací kurzory a detekce změn mezi stránkami |
| [#135](https://github.com/Kocooour/AI-executive/pull/135) | Sloučeno | Staging-only **read-only preflight** oprávnění a revize; nepovoluje ani neprovádí zápis |
| [#136](https://github.com/Kocooour/AI-executive/pull/136) | Sloučeno | Dokumentační aktualizace roadmapy R2–R4 |
| [#137](https://github.com/Kocooour/AI-executive/pull/137) | Sloučeno | První staging-only transakční změna názvu úkolu s aktuální ACL a revizí |
| [#138](https://github.com/Kocooour/AI-executive/pull/138) | Sloučeno | Atomická, trvalá a podle aktéra oddělená potvrzení úspěšných příkazů, bezpečné replay/konflikty; limit 4096 na staging store |
| [#139](https://github.com/Kocooour/AI-executive/pull/139) | Sloučeno | Autorizované ověření výsledku nejistého příkazu; receipt vázaný na aktéra + úkol + UUID příkazu |
| [#140](https://github.com/Kocooour/AI-executive/pull/140) | Sloučeno | Monotónní task/policy CAS ve staging schema v2, ochrana proti ABA a opětovnému použití ID |
| [#141](https://github.com/Kocooour/AI-executive/pull/141) | Sloučeno | Staging schema v3: obsahově úsporný transakční audit title write a minimální retenční/kapacitní bariéra |
| [#142](https://github.com/Kocooour/AI-executive/pull/142) | Sloučeno | Opt-in owner-cookie HTTP GET osobních úkolů s podepsaným cursor stránkováním; omezený izolovaný čtecí podproces |
| [#143](https://github.com/Kocooour/AI-executive/pull/143) | Sloučeno | Opt-in owner-cookie GET detailu jediného soukromého úkolu |
| [#144](https://github.com/Kocooour/AI-executive/pull/144) | Sloučeno | Opt-in owner-cookie GET seznamu vlastních soukromých projektů; staging schema v4 chrání projektové revize proti ABA a ID reuse |
| [#145](https://github.com/Kocooour/AI-executive/pull/145) | Sloučeno | Opt-in owner-cookie GET detailu soukromého projektu |
| [#146](https://github.com/Kocooour/AI-executive/pull/146) | Sloučeno | Owner-only náhled auditní časové osy změn názvu úkolu |
| [#147](https://github.com/Kocooour/AI-executive/pull/147) | Sloučeno | Výchozí vypnutý owner-private title GET preflight / PATCH přes HTTP |
| [#148](https://github.com/Kocooour/AI-executive/pull/148) | Sloučeno | Výchozí vypnuté POST ověření výsledku přesného příkazu změny názvu |
| [#149](https://github.com/Kocooour/AI-executive/pull/149) | Sloučeno | Detail soukromého úkolu vrací title CAS `snapshotRevision` ze stejného preflightovaného snapshotu |
| [#150](https://github.com/Kocooour/AI-executive/pull/150) | Sloučeno | Revize stavu R2 a plán iterace R2-ID |
| [#151](https://github.com/Kocooour/AI-executive/pull/151) | Sloučeno | Povinné nezávislé code review na každém PR (AGENTS.md, DEVELOPMENT.md) |
| [#152](https://github.com/Kocooour/AI-executive/pull/152) | Sloučeno | R2-ID.1: trvalé staging sessions, revokační epocha, živé ověření session před uvolněním odpovědi i v zápisové transakci |
| [#153](https://github.com/Kocooour/AI-executive/pull/153) | Sloučeno | R2-ID.2a: idempotentní admin příkaz členství, schema v6, ochrana posledního admina, `WITHOUT ROWID` a rowid triggery |
| [#154](https://github.com/Kocooour/AI-executive/pull/154) | Sloučeno | R2-ID.2b: čtení `Sdílené` / `Můj plán`, linearizační kontrola všech přispívajících Oblastí, `read_stale_reload` |
| [#156](https://github.com/Kocooour/AI-executive/pull/156) | Sloučeno | Diagnostika testu rozsahů LUMI-FR-013 |
| [#157](https://github.com/Kocooour/AI-executive/pull/157) | Sloučeno | Issue #155: cursor revize indexované podle Oblastí místo přepočtu celého rozsahu |
| [#158](https://github.com/Kocooour/AI-executive/pull/158) | Sloučeno | R2-ID.3: změna názvu sdíleného úkolu podle role, CAS revize v detailu jen pro editora/admina |

## Revize stavu R2 (2026-10-29)

- **Tok jedné identity má funkční staging základ.** Owner-private čtení, jediná mutace (název úkolu), idempotence, CAS, audit a zotavení z nejisté odpovědi jsou staging-only implementované a pokryté testy pro jedinou identitu; nezávislé bezpečnostní review a produkční připravenost chybí.
- **Kritéria R2 zatím nejsou ověřitelná.** Testy cizích a sdílených dat dosud pracují se syntetickými řádky, nikoli s druhou autentizovanou identitou. Chybí trvalé identity uživatelů, durable a víceprocesová revokace, čtení sdílených Oblastí a role viewer/editor/admin při zápisu.
- **Riziko rozšiřování do šířky:** PR #146–#149 zpřesňovaly tentýž jednouživatelský tok. Další iterace musí přinést **novou ověřitelnou schopnost** podle kritérií R2, nikoli další helper téhož toku.
- **Rozhodnutí vlastníka 2026-10-29** (schválení doporučení revize stavu v pracovní session [Claude Code](https://claude.ai/code/session_018VgJSMApVuidbxx5VDwyE5)): další iterací je **R2-ID** (identita a první sdílená Oblast) **před R2c** (sync bariéra a cache), protože oddělení cache, offline front a revokace v synchronizaci na identitě závisí.

## Aktuální staging kontrakt

Celá R2 implementace je **staging-only**, za explicitními serverovými flagy, výchozí vypnutá a nad izolovaným úložištěm. Zelené CI samo o sobě neznamená aktivaci ani splnění produkčních ACL.

**Schéma a revize.** Staging schema v2–v4 přidává `tasks.revision`, `areas.policy_revision` a monotónní projektové revize; SQLite triggery je zvyšují i při návratu hodnoty do původního stavu (ABA). Starší staging schémata se **automaticky nemigrují**; izolované testovací úložiště se znovu vytvoří bootstrapem, produkční data nejsou dotčena. Smazání úkolu je dočasně zakázáno, aby se ID nemohlo znovu použít s revizí 0; odstranění omezení vyžaduje trvalé tombstony. Staré actor-only receipty z #138 vedou k odmítnutí staging preflightu.

**Identita a sessions.** Interní session authority a revokace jsou **process-local**. HTTP endpointy používají skutečnou owner cookie pouze pro explicitně povolené staging cesty. Nejde o produkční víceuživatelskou session službu ani o durable multiuser revokaci.

**Čtení (`/api/target-staging/...`).**
- `GET tasks` a `GET projects`: stránkování (nejvýše 100 položek) s cursorem podepsaným oddělenou HMAC doménou ze serverového session secretu, vázaným na owner cookie, aktéra, staging directory, restore generation a hash **pouze autorizovaných** vlastních řádků. Platí nejvýše 15 minut; změna cookie, konfigurace, autorizovaných vlastních položek nebo expirace vyžaduje nové načtení od první stránky, změny cizích nebo sdílených položek osobní cursor nezneplatní. Cursor není autentizační token a nevolí identitu ani rozsah; actor, Oblast ani scope nelze dodat klientem.
- `GET tasks/[taskId]` a `GET projects/[projectId]`: jediné preflightované snapshot čtení s osobním rozsahem v autentizovaném SQL. ID je jediný parametr cesty, omezený na 512 UTF-8 bytů bez krajních mezer a řídicích znaků. Neznámé, cizí a sdílené položky vracejí nerozlišitelné 404 bez cache. Projekt vrací jen `id`, `title`, `areaId`, `areaKind=private`. Detail úkolu vrací navíc title CAS `snapshotRevision` ze stejného snapshotu.
- `GET tasks/[taskId]/audit`: cizí, sdílené a neexistující úkoly vracejí nerozlišitelné 404; jinak nejnovějších 50 záznamů vlastního aktéra, aktuální Oblasti a restore generace; pouze `revisionBefore`, `revisionAfter`, `committedAtMs`.
- Každý požadavek znovu ověřuje cookie a ACL v izolovaném čtecím podprocesu s limity souběhu, času a velikosti odpovědi. Nejde o náhradu produkčního zátěžového testu.

**Zápis názvu úkolu.** Samostatný, výchozí vypnutý flag `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED=true` nad čtecím flagem.
- `GET`/`PATCH tasks/[taskId]/title`: pouze vlastní soukromý úkol; shared, cizí a neexistující úkoly jsou nerozlišitelné 404. Write ACL se opakuje uvnitř `BEGIN IMMEDIATE` s task/policy revizí a restore generation. Idempotentní receipt je vázaný na aktéra + úkol + UUID příkazu; změna payloadu pod stejným UUID je konflikt.
- Každá úspěšná změna má ve stejné transakci obsahově úspornou auditní událost (bez textů názvů). Replay a no-op nevytváří další záznam, selhání auditu vrací celý zápis. Prozatímní minimální 90denní ochrana před smazáním a tvrdý limit 4096 událostí; při nasycení se zápis bezpečně odmítne.
- `POST tasks/[taskId]/title/status`: tělo `commandId`, `title`, `expectedRevision`; vrací `committed` / `not_recorded`; konflikt obsahu pod stejným `commandId` 409; vypnutý flag a úkol, ke kterému aktér nemá přístup (cizí, sdílený či neexistující), nerozlišitelné 404. Hraniční chyby mají vlastní kódy: neplatný vstup 400 (případně jiný stav `HttpInputError`, např. příliš velké tělo), chybějící autentizace 401 (ověřuje se i po návratu čtecího podprocesu), cizí origin 403, rate limit 429 s `retry-after`, nedostupná nebo změněná staging konfigurace 503. `not_recorded` neopravňuje k nebezpečnému opakování; retry znovu prochází ACL, generací a CAS.

**Stále neimplementováno:** audit zamítnutých pokusů, přímých SQL úprav a Area/member operací, produkční retence/export/archivace auditu, trvalé multi-process revokace, sdílené Oblasti s rolemi, sync, user-scoped cache, UI ani produkční aktivace.

## Další iterace: R2-ID — trvalá víceuživatelská identita a první sdílená Oblast (staging)

**Cíl:** první funkční řez se **2–3 odlišnými autentizovanými syntetickými identitami** na izolovaném stagingu. Nerozšiřovat dále tok jediného vlastníka.

| Krok | Obsah | Brána |
|---|---|---|
| **R2-ID.1** *(sloučeno v [#152](https://github.com/Kocooour/AI-executive/pull/152); místo nové tabulky `users` se používá stávající `identities`)* | Staging schema v5: `users`, trvalé `sessions` a revokační epocha v SQLite. Session cookie vázaná na `userId`, nikoli na pevného `owner`. Čtecí i zapisovací proces ověřuje session a revokaci v transakci. Čtení nad pinned snapshotem navíc **těsně před uvolněním odpovědi** znovu ověří session a revokační epochu proti autoritativnímu živému session store (nikoli proti historickému snapshotu); zápis ověřuje session uvnitř `BEGIN IMMEDIATE` před commitem. | Revokace platí okamžitě i na jiném serverovém procesu a po restartu; ověřit testem se dvěma serverovými procesy nad stejným staging úložištěm a restartem mezi revokací a dalším požadavkem. Deterministické testy se synchronizační bariérou: `start čtení → revokace na jiném procesu → dokončení čtení` vrátí 401 bez dat; `start zápisu → revokace → commit` zápis zamítne bez změny, receiptu i auditu. Starší staging schéma vyžaduje nový bootstrap, žádná migrace produkčních dat. |
| **R2-ID.2** *(sloučeno v [#153](https://github.com/Kocooour/AI-executive/pull/153), [#154](https://github.com/Kocooour/AI-executive/pull/154) a [#156](https://github.com/Kocooour/AI-executive/pull/156))* | Členství ve sdílené Oblasti a matice rolí. **Stav: R2-ID.2 je rozděleno na 2a = příkaz členství (staging schema v6, `POST /api/target-staging/areas/[areaId]/members`, implementováno staging-only za stávajícími HTTP + write příznaky, bez UI) a 2b = čtení sdílených Oblastí / `Můj plán` (paralelní PR). V 2a nemá staging schéma stav dokončení úkolu, proto se při odebrání/snížení na viewer zruší přiřazení **všech** úkolů daného člena v Oblasti; zachování historické atribuce dokončených úkolů je odloženo do zavedení stavu dokončení.** Staging-only admin příkaz pro přidání/odebrání člena a změnu role jako samostatná auditovaná a **idempotentní** transakce (dle [architektury](ARCHITECTURE.md)): `commandId` s receiptem vázaným na aktéra, Oblast a payload, CAS na očekávanou `policy_revision` a její zvýšení při změně; přesný retry vrátí uložený výsledek, jiný payload pod stejným `commandId` je konflikt 409, zastaralá revize nic nezapíše; posledního admina nelze odebrat bez předání správy; odebranému členu i členu sníženému na viewer se ve stejné transakci zruší přiřazení nedokončených úkolů (zůstanou **Nepřiděleno**); dokončené úkoly si přiřazení ponechají jako historickou atribuci, která nezakládá oprávnění, a zůstávají čitelné oprávněným členům; viewer ani nečlen nesmí být řešitelem nedokončeného úkolu; budoucí znovuotevření úkolu (mimo rozsah R2-ID) musí neplatné přiřazení zrušit; attention upozornění správci je mimo rozsah. Řešitelé sdílených úkolů se pro testy nastavují v syntetických fixtures, příkaz přidělování je mimo rozsah. Čtení seznamu a detailu úkolů ve sdílené Oblasti podle aktuálního členství; rozsahy `Sdílené` a `Můj plán` (soukromé + mně přidělené) nad stejným preflightovaným snapshotem. **Linearizační bod čtení:** těsně před uvolněním odpovědi se v krátké read transakci nad autoritativním živým store ověří nejdřív session a revokační epocha (neplatná → 401), potom pro každou Oblast, ze které odpověď bere data, počty, revize, metadata nebo cursor, včetně soukromých (vazba na vlastníka), aktuální členství, role a `policy_revision` shodná se snapshotem. Změna řešitele `policy_revision` nemění: nemění oprávnění (člen Oblasti úkol vidí i v `Sdílené`), takže zastaralý řádek v `Můj plán` je jen neaktuálnost, ne únik dat. `Můj plán` se proto při změně řešitele může opozdit o jeden požadavek (kontrolní bod revize úkolů nekontroluje) a změna řešitele nesmí zbytečně shazovat CAS souběžných zápisů; test ověří, že přeřazení `policy_revision` nezvýší. Změna commitnutá před tímto bodem znamená, že se data nevydají: detail vrátí nerozlišitelné 404 s `no-store`; seznam, stránka i `Můj plán` vrátí 409 s `no-store` a samostatným strojově čitelným kódem `read_stale_reload`, odlišitelným od prázdného seznamu i od konfliktu příkazu (`commandId`). Změna commitnutá až po tomto bodu se uplatní na další požadavek. | Nečlen dostane nerozlišitelné 404; žádný únik přes cursor, revize, počty ani staleness. Deterministický test s bariérou pro rozpracované čtení (detail, stránkování i `Můj plán`): `start čtení B → admin A na jiném procesu odebere B nebo mu sníží roli → dokončení čtení` nevydá data, ke kterým B ztratil přístup; změna commitnutá až po kontrolním bodu se uplatní na další požadavek; `Můj plán` se soukromou i sdílenou Oblastí; souběh revokace session a odebrání členství vrátí 401; odpověď `read_stale_reload` klient nezamění za prázdný seznam ani za konflikt příkazu. Implementační PR R2-ID doplní tento kontrakt do [ARCHITECTURE.md](ARCHITECTURE.md). |
| **R2-ID.3** *(sloučeno v [#158](https://github.com/Kocooour/AI-executive/pull/158); staging-only, bez UI a bez nového příznaku; čtecí audit sdílených úkolů zůstává mimo rozsah)* | Title PATCH na sdíleném úkolu podle role: viewer zamítnut, editor/admin povoleno. Změna role nebo odebrání člena během zápisu vede k bezpečnému zamítnutí přes `policy_revision`. Audit zaznamená skutečného aktéra. | Receipty a ověření výsledku jsou oddělené podle identity; revokovaná session nemůže dokončit čekající příkaz. |

**Akceptační scénáře (syntetické identity A, B, C):**
1. A nevidí ani nezmění soukromé úkoly a projekty B, a to ani přes seznam, detail, audit, cursor, `snapshotRevision`, stav příkazu či rozdíl odpovědí.
2. Sdílená Oblast s A = admin, B = editor, C = viewer: C čte, ale nezapisuje; B zapisuje; po odebrání B je jeho další požadavek odmítnut, i na jiném procesu a po restartu. Rozpracované čtení B, během kterého je B odebrán, nevydá data sdílené Oblasti (linearizační bod v R2-ID.2).
3. Revokace session A zablokuje pokračování stránkování, čekající PATCH i ověření výsledku příkazu, a to i na druhém procesu a po restartu; revokovaná session dostane 401, nikoli 404.
4. `Můj plán` u B obsahuje jen jeho soukromé úkoly a sdílené úkoly přidělené B; nepřidělené a cizí přidělené sdílené úkoly zůstávají jen v `Sdílené`. Pokud krok zahrne seznam projektů, `Můj plán` obsahuje soukromé projekty B a sdílené projekty s alespoň jedním aktivním úkolem přiděleným B.
5. Souběžná změna členství a zápis (deterministicky dvěma procesy se synchronizační bariérou): buď zápis proběhne s původním oprávněním před změnou, nebo je zamítnut; nikdy nevznikne zápis s odebraným oprávněním.
6. Receipty a ověření výsledku příkazu jsou oddělené podle identity: B nezjistí ani nezopakuje příkaz A se stejným `commandId`.
7. Viewer ani nečlen nemůže být řešitelem **nedokončeného** úkolu: bootstrap/fixture takové přiřazení odmítne. Test downgrade editor → viewer s jedním dokončeným a jedním nedokončeným úkolem: nedokončený skončí **Nepřiděleno**, dokončený si ponechá historickou atribuci a zůstane čitelný oprávněným členům; čtecí model historicky platné dokončené úkoly neodmítá.
8. Admin příkaz členství: přesný replay nevytvoří druhou změnu, audit ani zvýšení revize; kolize payloadu pod stejným `commandId` vrátí 409; příkaz se zastaralou `policy_revision` se zamítne beze změny; ne-admin příkaz nemůže provést; odebrání nebo snížení posledního admina se zamítne; ze dvou souběžných příkazů se stejnou očekávanou `policy_revision` (deterministicky bariérou) uspěje nejvýše jeden.

**Mimo rozsah R2-ID:** sync protokol a cache (R2c), agregace Home/Today/Search (R2d), passkeys, obnova účtu a skutečné pozvánky (R5), UI a jakákoli práce s produkčními daty. Flagy zůstávají výchozí vypnuté.

**Postup:** podle [AGENTS.md](../AGENTS.md) — implementace v samostatné větvi/worktree s odděleným portem a staging adresářem, dva nezávislí testeři (funkce/akceptace; regrese/bezpečnost/integrita), [povinné code review](../AGENTS.md#mandatory-code-review-on-every-pr) po každém pushi s vyřešením nálezů, během vývoje jen `PR Checks` a cílené testy.

## Další iterace: R2c — synchronizační protokol cílového modelu a identity-scoped cache (staging)

**Výchozí rozhodnutí:** legacy úložiště (`GET/PUT /api/store`, globální snímek) a cílový staging store zůstávají **oddělené**. R2c nestaví nový protokol přestavbou legacy `PUT`. Cílový store snímek **nikdy nepřijme**, každý zápis je per-item příkaz. Legacy klient zůstává na legacy úložišti až do cutoveru (R4). Bariéra pro staré klienty proto znamená, že cílové endpointy odmítnou cokoli bez explicitní verze protokolu a v tvaru snímku, a to **před jakoukoli mutací**.

**Cíl:** na izolovaném stagingu dokázat úplný synchronizační cyklus pro 2–3 syntetické identity: stažení autorizovaných změn, offline fronta příkazů, konflikty, odvolání přístupu a obnova ze zálohy. Nic nesmí uniknout přes klientskou cache a nic se nesmí potichu ztratit.

| Krok | Obsah | Brána |
|---|---|---|
| **R2c.1 — Tombstony a změnový záznam** | Staging schema v7: monotónní per-store sekvence změn a trvalé **tombstony** úkolů a projektů (zruší dočasný zákaz mazání a ochrání ID před znovupoužitím). Idempotentní příkaz smazání úkolu se stejnou ACL, CAS, receiptem a auditem jako title write. | Smazání a opětovné vytvoření stejného ID nevytvoří ABA (revize i tombstone zůstávají). Opakování příkazu nevytvoří druhý tombstone ani audit. Viewer, nečlen a cizí soukromý úkol dostanou nerozlišitelné 404. |
| **R2c.2 — Autorizovaný změnový feed** | `GET /api/target-staging/changes?since=<cursor>` vrací pro aktuální identitu jen autorizované změny: upserty, tombstony a **oznámení ztráty přístupu** k Oblasti (bez obsahu). Cursor je podepsaný a vázaný na identitu, session a `restoreGeneration`. Platí stejný linearizační bod čtení jako v R2-ID.2b. Při změně `restoreGeneration` server vrátí jednoznačný kód „resync required“. | Změny v Oblastech, které aktér nevidí, neovlivní jeho feed ani cursor. Odebraný člen dostane jen oznámení ztráty přístupu, žádná data. Zastaralý cursor po obnově zálohy vrátí resync, nikdy částečná data. Bariérové testy změny členství během čtení feedu. |
| **R2c.3 — Bariéra protokolu** | Všechny zápisové cílové endpointy vyžadují explicitní hlavičku verze protokolu. Payload ve tvaru legacy snímku (`entities` / `relations` / `baseRevision`) nebo chybějící či neznámá verze se odmítne **před mutací** jednoznačným kódem. Legacy `/api/store` zůstává beze změny. | Test pro každý zápisový endpoint: payload bez verze, se starou verzí a v tvaru snímku nic nezapíše (úkol, receipt, audit, tombstone beze změny). Legacy testy zůstávají zelené beze změny. |
| **R2c.4 — Klientské sync jádro (bez UI)** | Knihovna v `lib/` s abstraktním úložištěm. Lokální jmenný prostor je vázaný na `userId` + `restoreGeneration`, takže data dvou identit na jednom zařízení se nikdy nemíchají. Offline fronta příkazů s `commandId`; po nejisté odpovědi se výsledek ověří přes status endpoint místo slepého opakování. Konflikt (409) zachová lokální koncept a nabídne nové načtení, nikdy tiché zahození. Ztráta přístupu nebo odvolání session (401) smaže data a frontu dané Oblasti nebo identity a ohlásí počet neodeslatelných změn. Změna `restoreGeneration` vyprázdní cache a znovu stáhne data **bez opětovného nahrání** starých položek. | Unit testy nad paměťovým adaptérem úložiště, cílené Playwright scénáře nad IndexedDB adaptérem (bez plné E2E sady). Odhlášení identity A a přihlášení B na stejném zařízení nevydá B nic z A. |

**Akceptační scénáře (syntetické identity A admin, B editor, C viewer, D nečlen):**
1. B offline upraví název sdíleného úkolu, mezitím ho A smaže. Po připojení B dostane konflikt nebo tombstone, jeho změna se neztratí potichu (koncept zůstane k dispozici) a smazaný úkol se znovu nevytvoří.
2. B offline zařadí do fronty tři změny, mezitím ho A odebere z Oblasti. Po připojení server všechny tři odmítne, klient smaže data té Oblasti i frontu a ohlásí 3 neodeslatelné změny. Feed B nevydá žádný obsah Oblasti.
3. Revokace session C: další požadavek feedu vrátí 401 a klient smaže jmenný prostor C.
4. Obnova staging úložiště ze zálohy (nová `restoreGeneration`): starý cursor vrátí „resync required“, klient vyprázdní cache a stáhne nová data a žádný starý příkaz z fronty se nezapíše do nové generace bez nové autorizace.
5. Dva klienti téže identity souběžně mění tentýž úkol: právě jeden zápis uspěje, druhý dostane 409 se zachovaným konceptem. Opakování se stejným `commandId` nezpůsobí dvojí změnu.
6. Legacy klient poslaný na cílový endpoint (tvar snímku nebo bez verze protokolu) nic nezapíše.
7. D z feedu nezjistí existenci, počet ani revize úkolů Oblastí, kde není členem.

**Návrh k rozhodnutí vlastníka:** odvozené kanály **search index, attention a push** v cílovém modelu zatím neexistují, takže je navrhuji přesunout z R2c do **R2d** spolu s agregacemi Home/Today/Inbox/Search. R2c dodá kontrakt, který R2d použije: klientská data vázaná na identitu a mazání při ztrátě přístupu.

**Mimo rozsah R2c:** UI a zapojení do `use-lumi-app` (R3), migrace legacy offline front a Dexie dat (inventura a rozhodnutí patří do R4), produkční aktivace a jakákoli práce s produkčními daty. Příznaky zůstávají výchozí vypnuté.

**Postup:** podle [AGENTS.md](../AGENTS.md). Každý krok je samostatný PR s implementačním agentem, dvěma nezávislými testery, [povinným code review](../AGENTS.md#mandatory-code-review-on-every-pr) a lokálním během `typecheck`, `test`, `build` a Next smoke. R2c.1 až R2c.3 jdou postupně (schéma), R2c.4 může běžet paralelně od R2c.2 s integrační větví.

## Kritická cesta

Neprodlužovat R2 sérií dalších samostatných diagnostických helperů bez vazby na fungující bezpečný vertikální tok. Další implementace mají přidávat **ověřitelnou funkční schopnost** a negativní testy, nejdřív na izolovaném stagingu, teprve potom ve skutečném runtime.

| Pořadí | Iterace | Požadovaný výsledek a brána |
|---|---|---|
| **1** | **R2a/R2b — #131–149 sloučeny** | Jednouživatelský owner-private staging tok čtení, title write, idempotence, CAS, audit a zotavení. Audit odmítnutých a dalších bezpečnostně významných operací, produkční retenční/exportní lifecycle a nezávislé bezpečnostní review stále chybí. Produkční aktivace není povolena. |
| **2** | **R2-ID — dokončeno (#152–#158)** | Trvalé identity a sessions, durable víceprocesová revokace, sdílená Oblast s rolemi viewer/editor/admin pro čtení a title write; akceptační scénáře výše. |
| **3** | **R2c — Sync bariéra a cache (další iterace, viz níže)** | Verzované per-item zápisy/tombstony místo legacy global `PUT`; staré full-snapshot klienty zablokovat **před mutací**. Oddělit IndexedDB/cache a osobní stav podle identity; řešit offline fronty, konflikty, revokaci, `restoreGeneration`, obnovu, index, attention a push. Starý obsah nesmí být znovu nahrán ani potichu zahozen. |
| **4** | **R2d — Kompletní autorizované čtení** | Rozšířit autorizaci na projekty, poznámky a vztahy i agregace **Home/Inbox/Today/Upcoming/Projects/Search/counts/attention/AI**; zakázat únik přes metadata, počty, notifikace, export a cache. Přesné aktivní projektové membership/assignee pravidlo pro Můj plán. |
| **5** | **R3 — Propojit D3 s UI** | Zapojit existující #103/#108 do desktopu a mobilu; Home zůstane úvodní obrazovkou a Můj plán výchozím **čtecím rozsahem**. Zápisy mají vždy jednu viditelnou cílovou Oblast; `Nezařazeno` je soukromé; sdílení vyžaduje souhlas. Ověřit 2–3 identity, mobil, klávesnici/VoiceOver a offline/revokační případy. |
| **6** | **R4 — Produkční připravenost a cutover** | Zafixovat cílové schéma s migracemi místo staging bootstrapů; inventura, recoverable archivní záloha a **otestovaný restore**, plán pro stávající klienty/integrační tajemství; teprve po **samostatném souhlasu vlastníka** přepnutí do nového úložiště. Produkční nasazení až po povinné plné Browser E2E release gate na **přesném SHA**. |

Iterace 2–4 lze rozdělit do menších reviewovatelných PR, ale jejich výsledek se má posuzovat podle konkrétních akceptačních scénářů, **ne podle počtu PR**. Staging helper není prod-ready endpoint; přepnutí `enabled` v UI není serverové oprávnění.

## Kritéria dokončení R2 před D3

- **Read/write bezpečnost:** neautorizovaný aktér nemůže číst ani upravit osobní či cizí sdílenou Oblast; viewer nezapisuje, editor/admin jen dle aktuálního členství, projektové děti vždy dědí Oblast.
- **Transakční konzistence:** souběžná změna oprávnění/revize/generace během zápisu vede k bezpečnému zamítnutí; opakování příkazu nezpůsobí dvojí změnu, audit a Undo neobejdou ACL.
- **Synchronizace a revokace:** starý snapshot/pozdní offline fronta nemění novou generaci, po revokaci nevytéká obsah ani přes cache či odvozené kanály; uživatelské profily oddělené. Offline ztracená práva nelze zpětně odebrat již zkopírovanému obsahu, ale server musí po připojení přístup odmítnout.
- **Funkční úplnost:** autorizované task/project/detail a Home/Today/Inbox/Upcoming/search výsledky jsou vzájemně konzistentní. `Můj plán` obsahuje soukromé a mně přidělené sdílené úkoly, `Sdílené` také nepřidělené oprávněné položky.
- **Testování:** syntetické 2–3 identity, pozitivní i negativní scénáře pro čtení/zápis/souběh/offline/revokaci, pravidelné `PR Checks`, [povinné nezávislé code review](../AGENTS.md#mandatory-code-review-on-every-pr). Celá Browser E2E sada **jen před nasazením** dle [AGENTS.md](../AGENTS.md).

## Co se nemění

- **D2a–D2c legacy migrace a historické backfilly nejsou na kritické cestě.** Dosavadní implementace/testy se nemažou; pokud se později objeví hodnotná data, rozhodne se o jejich konkrétním převodu samostatně.
- Připravovaný čistý model lze vytvářet a testovat pouze v **odděleném úložišti**. Žádná změna roadmapy ani merge PR nedává souhlas ke smazání/nahrazení aktuální produkční DB, účtů, mailu, kalendáře, tokenů či offline cache.
- Před případným resetem: explicitně schválený rozsah, ověřená archivní záloha, test obnovy, inventura zařízení a konektorů. Nespouštět pozvánky ani skutečné sdílení před bezpečnostními branami.
- Product contract: jen dva uživatelské prostory **Osobní / Sdílený**; tři čtecí rozsahy **Můj plán / Osobní / Sdílené**. Oblast je jediný organizační štítek a zdroj viditelnosti projektů a samostatných úkolů; žádný implicitní přechod do sdílení.

**Nejbližší práce: R2c — tombstony a změnový záznam, autorizovaný změnový feed, bariéra protokolu a klientské sync jádro vázané na identitu, vše na izolovaném stagingu. UI, autorizované agregace a produkční cutover jsou samostatné následné brány.**
