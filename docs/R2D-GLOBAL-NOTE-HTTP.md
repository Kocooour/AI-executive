# R2d.3m.6 — globální HTTP index názvů poznámek (staging-only)

Navazuje na sloučený [interní index poznámek](R2D-GLOBAL-NOTE-READ.md)
(R2d.3m.5, #243). **Není součástí produkčního UI, produkčního API ani
kombinovaného přehledu Vše.** Je to výhradně nová,
výchozím nastavením vypnutá staging čtecí brána.

## API a aktivace

`GET /api/target-staging/note-index/global`

Zároveň vyžaduje:
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_NOTES_ENABLED=true`

Bez obou flagů vrací 404; izolovaný child ověřuje tytéž přepínače.
Aktivace projektu ani úkolového globálního indexu **nezapíná** poznámky.

Parametry: `scope=all|personal|shared` (výchozí `all`),
`limit=1..100` (výchozí 50) a neprůhledný HMAC `cursor` (max. 4096 znaků).
Neznámé, duplicitní či nepovolené parametry, přímý `offset` a
libovolné přepsání `actor` jsou odmítnuty (400).
Před spuštěním child procesu proběhne kontrola autentizace,
restore generation, staging anchoru a platnosti relace,
plus samostatný rate limit 120 požadavků za 10 minut.

`all` zahrnuje všechny vlastní soukromé poznámky a všechny poznámky
v aktuálně čitelných sdílených Oblastech, i pro roli `viewer` a bez
vztahu k přiřazení úkolu; `personal` jen vlastní soukromé,
`shared` jen sdílené. Dítě projektu dědí Oblast od přímého projektu,
nikoli z textových zmínek či backlinků.

Odpověď `{scope,notes,hasMore,nextCursor}` obsahuje
pouze pole poznámek
`{id,title,projectId,areaId,areaKind,revision}`.
**Tělo poznámky, autor jiné soukromé Oblasti, členové, osobní plán,
interní `linearization`, Area svědectví a `revision` indexu se nevrací.**
Vždy `Cache-Control: no-store`.

## Bezpečnostní a revizní kontrakt

Krátký izolovaný subprocess používá ověřeného aktéra nebo hash
aktuální durable session. Čte kanonicky preflightovaný,
připnutý SQL snapshot, kde ACL i validita poznámkových ID
předchází řazení a stránkování.

Parent odmítá každý child DTO s neznámými atributy,
neplatným ID, přetečeným title, změněným scope,
neplatným parent ID, chybějícími, neuspořádanými
nebo neúplnými Area epochami. Striktně ověřuje
`areaEpochs` a navíc **`noteAreaEpochs`**
obsahující `note_sync_revision` pro úplnou množinu aktuálně
čitelných Oblastí včetně prázdných. Selhání kterékoliv části
odmítne celý child výsledek.

Continuation cursor opakovaně využívá prověřený HMAC primitiv
staging cursor knihovny, ale s **vlastní doménou**
`lumi:r2d:global-note-http-cursor:v1`. Je vázán na současného
aktéra/session, scope, limit, staging path a restore generation
a revizi indexu (včetně note-specific epoch). Projektový, úkolový
ani cizí kurzor nelze použít. Neplatný cursor znamená 400,
stale/expired 409.

**Těsně před vydáním názvů** provádí server
`verifyStagingReadBeforeRelease` v jednom live SQLite čtení
aktuální session/owner identity, ACL a role, úplný seznam
přípustných Oblastí, jejich policy/content/project-content
epochy **a navíc všechny `note_sync_revision` epochy**.
Změna těla/názvu poznámky, rodiče, členství nebo nové prázdné
Oblasti po snímku způsobí 409, nikoli zveřejnění zastaralých dat.
Neúspěch procesu a nekonzistentní odpověď znamenají 503.

## Regrese a zbytek vývoje

`tests/target-staging-global-note-http.test.mjs` pokrývá oddělené
default-off flagy, owner i durable-session identitu,
viewer/editor, cizí soukromé názvy, absenci body,
allowlist parametrů, originální HMAC podpis cursoru,
vazbu na scope/limit/session, křížové použití s projektem,
body-only edit, atomickou revokaci relace/členství,
nově čitelnou prázdnou Oblast a forged child DTO.
Je součástí cíleného R2d CI. Plné browser E2E
zůstává předprodukční bránou.

Další iterace R2d.3m.7 může sjednotit oddělené
globální task/project/note čtecí zdroje do autorizovaného
kombinovaného modelu pro UI-09/R3. Tento PR **nepovoluje**
cutover, migraci, reset, produkční feature flag ani deploy.
