# R2d.3m.4 — globální projektový HTTP index (staging-only)

Navazuje na sloučené [R2d.3m.3](R2D-GLOBAL-PROJECT-READ.md)
a jeho actor-scoped interní projektový index. Rozhraní
**neaktivuje produkční UI, neslouží jako úplné kombinované Vše**
a nijak neupravuje databázi ani uložená data.

## Kontrakt

`GET /api/target-staging/project-index/global`

Dvě nezávislé bariéry, **výchozí OFF**:
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a
`AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED=true`.
Pokud nejsou obě nastaveny, endpoint vrací 404 a izolovaný
child odmítne čtení. Zapnutí existujícího task-only HTTP
endpointu neaktivuje tento nový endpoint.

Povolené parametry:
`scope=all|personal|shared` (výchozí `all`),
`limit=1..100` (výchozí 50), `cursor` (neprůhledný,
podepsaný, maximálně 4096 znaků).
Neznámé a duplicitní parametry, přímý `offset` i
jakýkoli pokus o přepsání `actor` vrací 400.
Před child readem proběhne autentizace a stavová
kontrola restore/anchor, následně samostatný rate limit
120 požadavků za 10 minut.

`all` = všechny aktérovy soukromé projekty a **všechny**
aktuálně čitelné sdílené projekty (viewer/editor/admin),
bez závislosti na tom, komu jsou přiřazené úkoly; tedy i
prázdné projekty. `personal` = jen vlastní soukromé,
`shared` = pouze čitelné sdílené.
To se liší od Mého plánu.

Úspěšná odpověď má výhradně
`{scope,projects,hasMore,nextCursor}`,
kde `projects` jsou `{id,title,areaId,areaKind}`.
Vynechává identitu aktéra, členy, cizí soukromé názvy,
přiřazení úkolů, privátní `whenOn`, interní
`revision`, `linearization` i celé `areaEpochs`.
Vždy `cache-control: no-store`.

## Bezpečnost

- Samostatný krátkodobý read-only child přijímá jen
  ověřeného aktéra nebo hash aktivní staging durable
  session; přísně omezené `scope`, `limit` a
  serverově vypočtený `offset`. Kanonický preflight
  a actor-bound SQL jsou v jednom připnutém SQLite
  read snapshotu. ID projektů neodpovídající
  pravidlům se odstraní v SQL **před stránkováním**.
- Parent child DTO přísně validuje: přesné klíče,
  stav/rozsah, plnou délku stránky pro `hasMore`,
  BINARY pořadí a unikátnost projektů, validitu
  projektových ID, shodný druh Oblasti,
  plné interní Area policy/content/project-content
  revize a jejich návaznost na linearization.
  Jakýkoliv dodaný nepovolený atribut znamená
  odmítnutí celé odpovědi.
- HMAC continuation cursor je oddělen od taskového
  endpointu, vázán na aktéra, ověřenou session,
  `scope`, `limit`, adresář stagingu, restore
  generation a kompletní revision stránky.
  Podvržený/nesprávný cursor => 400; vypršelý
  nebo po změně revizí => 409.
- **Těsně před vydáním dat** parent ověří aktuální
  identitu, session, ACL všech aktérem čitelných
  Oblastí včetně prázdných, jejich přístupové role
  a policy/content/project-content epochy v
  jednom live read guardu. Změna obsahu nebo členství
  po snapshotu znamená 409 či zamítnutí relace,
  nikdy vydání neaktuálního soukromého titulu.

## Testy a pokračování

`tests/target-staging-global-project-http.test.mjs`
testuje default-off oddělené flagy, owner i
durable-session identity, viewer/editor/admin,
cizí soukromí, query allowlist, vázané kurzory,
stale revision, obsahové epochy a nově udělenou
prázdnou Oblast, revokaci členství i session,
invalidní projektové ID a striktní child DTO.
Zařazeno do cíleného R2d CI. Standardní PR Checks
dále kontrolují unit testy, typecheck a build.
Plné browser E2E zůstává předprodukční bránou.

Navazuje autorizační model pro globální poznámky
a nakonec společný read adaptér pro UI-09/R3.
Tento PR **není** povolení k produkčnímu cutoveru,
migraci, resetu, připojení do legacy API ani
zapnutí feature flags.
