# R2d.3m.2 — výchozí vypnutý globální task-only HTTP index

Tato iterace navazuje na serverový selektor
[R2d.3m.1](R2D-GLOBAL-TASK-READ.md). Vydává **jen úkoly**
aktuálně čitelné přihlášeným aktérem přes izolovaný
staging SQLite v21. Nejde o kompletní globální obsahové
„Vše“: projekty, poznámky, kalendář, Search/AI a produkční
UI zde zůstávají mimo rozsah. Nic není nasazeno ani
aktivováno, legacy store se neotevírá.

## Veřejný kontrakt (staging-only)

`GET /api/target-staging/task-index/global`

Přístup vyžaduje **obě** serverové bariéry:
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a
`AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_TASKS_ENABLED=true`.
Neaktivované vrací 404; izolované dítě kontroluje stejné
příznaky. Endpoint pouze čte.

Parametry: `scope=all|personal|shared` (výchozí `all`),
`limit=1..100` (výchozí 50), volitelný neprůhledný
`cursor`. Nic jiného, ani `actor`, `assignee`,
`offset` či `whenOn`, se nepřijímá. Neznámé nebo
duplicitní parametry a nekanonická čísla znamenají 400.
Stávající auth a restore/anchor admission se provedou
dřív než čtecí subprocess; samostatný rate-limit je
120 požadavků / 10 minut.

`all` obsahuje privátní úkoly aktéra a **všechny**
dostupné sdílené úkoly (`viewer/editor/admin`),
nezávisle na tom, komu jsou přidělené; `personal`
obsahuje pouze aktérovo soukromí a `shared` jen
čitelné sdílené. Nezaměňovat s `my-plan`, kde
sdílená práce vyžaduje současné přiřazení aktérovi.

Odpověď (`cache-control: no-store`):
`{scope,tasks,hasMore,nextCursor}`. Řádek obsahuje
`{id,title,projectId,areaId,areaKind,status,dueOn}`,
u sdílených položek navíc `assignedToMe:boolean`.
Nevydává cizí assignee ID, soukromé `whenOn`,
identitu aktéra, vnitřní `linearization`, epochy
Oblastí ani revision token. Pořadí je kanonické
`id COLLATE BINARY`, číselné stránkování je
interní pro podepsaný kurzor.

## Bezpečnost, konzistence, regresní testy

- Izolované čtecí dítě přebírá **hash durable staging
  session**, nikdy její raw bearer token. Identita se
  resolvuje z živého store; kanonický preflight,
  actor-bound podpis a SQL filtr všech oprávnění platí
  v jednom připnutém read snapshotu.
- Parent používá přísný allowlist DTO všech polí,
  rolí, Area witnesses, datumů, statusů, řazení,
  délky stránky a revizí. Detekuje chybně označené
  shared/private Areas, cizí identitu a dodaná interní
  pole před jakýmkoliv zveřejněním.
- Podpis kurzoru váže aktéra, aktuální relaci,
  store generation a cestu, `scope`, `limit`,
  stránkovací offset a obsahovou revizi všech
  přispívajících Oblastí. Výsledek po změně vrací
  409, nikdy část staré stránky.
- **Před uvolněním** proběhne v jedné čerstvé
  transakci kontrola session/actor, úplné množiny
  dostupných soukromých i sdílených Oblastí (včetně
  prázdných), jejich policy, content a project-content
  epoch. `all` používá `global-all` witness;
  samostatné rozsahy mají svůj scoped live guard.
  Revokace, přeřazení nebo změna názvu po snapshotu
  vrací `read_stale_reload` (409), nikoliv stará data.
- Výpadek child/preflightu znamená 503; neplatné
  session odpovídají stávajícímu HTTP auth kontraktu.

`tests/target-staging-global-task-http.test.mjs`
pokrývá dva oddělené flagy, HTTP admission,
admin/editor/viewer a cizí privátní data, nepřiřazené
i dokončené úkoly, projektové dědění Oblasti, striktní
parametry, actor/session-bound kurzor, zneplatnění
stránkování, revokaci session, změnu role a obsahových
epoch po snapshotu, nově přidanou prázdnou Oblast,
a falešnou odpověď izolovaného procesu. Test je
zařazen do cíleného R2d CI, kompletní browser E2E
zůstávají předprodukční release gate.

**Následuje:** dokončení bezpečné globální agregace
projektů/poznámek a integrace jediného globálního
přepínače v UI-09/R3. Výchozí aktivace cílové
databáze a případný cutover vyžadují samostatné
bezpečnostní rozhodnutí a výslovný souhlas.
