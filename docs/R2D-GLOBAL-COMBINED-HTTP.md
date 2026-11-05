# R2d.3m.8 — společný HTTP index Vše / Osobní / Sdílené (staging)

Navazuje na [R2d.3m.7](R2D-GLOBAL-COMBINED-READ.md), sloučené
v #246. V této iteraci vzniká **samostatný, default-off HTTP adaptér**
pro autorizovaný kombinovaný čtecí model, nikoli produkční
zapnutí aplikace či dokončený UI-09/R3 cutover.

## Rozhraní a zapínání

`GET /api/target-staging/global-index`

Dvě nutné podmínky (výchozí **OFF**):
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a
`AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED=true`.
Bez obou se vrací 404. Zapnutí tohoto nového flagu **nezapíná**
původní oddělené task/project/note endpointy; jejich flagy
nemusí být zapnuté. Stejnou bariéru vyžaduje izolovaný child.

Povolené query parametry: `scope=all|personal|shared` (výchozí
`all`), `limit=1..100` (výchozí 50) a `cursor`
(neprůhledný podepsaný token, max. 4096 znaků).
Nepovolené či duplicitní parametry, přímá trojice pozic,
`offset` nebo `actor` znamenají 400. Před child read
proběhne autentizace vlastníka / durable staging session,
kanonická kontrola restore/anchoru a rate limit
120 požadavků za 10 minut.

Úspěšná odpověď je přesně
`{scope,items,hasMore,nextCursor}`.
`items` jsou typované `{kind,item}`, kde:
- `project`: `{id,title,areaId,areaKind}`
- `task`: `{id,title,projectId,areaId,areaKind,status,dueOn}`
  a pouze ve sdílené Oblasti `assignedToMe` (boolean)
- `note`: `{id,title,projectId,areaId,areaKind,revision}`

Neobsahuje `note.body`, cizí osobní tituly, identifikátor
jiného přiděleného člověka, seznamy členů, `linearization`,
`areaEpochs`, `noteAreaEpochs`, interní `revision`
ani surové stránkovací pozice. Vždy `Cache-Control: no-store`.

## Autorizace, konzistence a revokace

Serverově ověřený owner či durable session se předá
do izolovaného krátkodobého subprocessu, nikdy jako
uživatelský query parametr. Subprocess se dotazuje
na **jediný kanonicky preflightovaný, připnutý SQLite
read snapshot** a kombinuje všechny tři druhy položek
z příslušných actor-ACL SQL selektorů. Každý filtruje
oprávnění **před** limitováním a stránkováním, včetně
`viewer` u sdílených Oblastí a prázdných sdílených projektů.

Nad procesní hranicí se nepovažuje JSON za důvěryhodný.
Parent přísně validuje exact-key all-list, přesný typ
každého řádku, bezpečné ID, BINARY pořadí napříč druhy
s tie-break `project → task → note`, úplnou
`linearization` všech čitelných Oblastí, Area policy,
content a project-content epochy **a** úplné samostatné
`note_sync_revision` epochy včetně prázdných Oblastí.
`nextPositions={projects,tasks,notes}` se musí přesně
rovnat předchozím pozicím plus počtu vydaných položek
každého druhu. Libovolné extra pole znamená odmítnutí
celého child výsledku, nikdy částečný výstup.

**Bezprostředně před vydáním položek** server atomicky
ověří živou relaci/identitu, celou oprávněnou množinu
Oblastí včetně nově přidělených prázdných Oblastí,
aktuální policy/content/project-content epochy a
`note_sync_revision` každé oblasti. Odvolání členství,
změna názvu či samotného `note.body`, změna rodiče,
restore či zneplatnění session po snímku nesmí vydat
zastaralá nebo soukromá data (409, 401 či fail closed).

## Podepsaný kombinovaný kurzor

Vlastní HMAC `lumi:r2d:global-combined-http-cursor:v1`
je oddělen od individuálních task/project/note kurzorů.
Váže identitu aktéra a konkrétní session / auth binding,
scope, limit, staging cestu, restore generation,
kompletní combined index revision a přesné trojice
pozic. TTL je nejvýše 15 minut, stávající expirace
se pokračováním neprodlužuje. Neplatný/podvržený/
cizí cursor → 400; expirovaný či zastaralý vůči
živému obsahu/ACL → 409. Kurzory samy o sobě
neposkytují oprávnění k přístupu.

## Testy, nasazovací hranice a další vývoj

`tests/target-staging-global-combined-http.test.mjs`
ověřuje nezávislost feature flagů, owner a durable
session, výběry `all/personal/shared`, viewer/editor,
prázdné projekty a děděné poznámky, absenci těla
poznámek, stabilní cross-kind stránkování,
HMAC scope/limit/session replay i expiraci,
odmítnutí kurzoru z jiného endpointu, body-only
revizní staleness, live revokaci členství a session,
nově zpřístupněnou prázdnou Oblast a forged
child DTO/epochy. Test je zahrnut v cíleném R2d CI;
plný Browser E2E zůstává předprodukční release gate.

R2d.3m.8 **nezapíná produkční API/UI, neprovádí migraci
nebo reset ani nasazení**. Pro UI-09/R3 musí být následně
ověřena integrace autorizovaného `Vše`, navigace,
prázdné/loading/error stavy a bezpečnostní bariéry R2d;
pro R4 je nutný samostatný explicitní souhlas.
