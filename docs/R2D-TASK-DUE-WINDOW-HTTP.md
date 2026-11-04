# R2d.3j.2 — HTTP čtení časových oken společných termínů

**Pouze izolovaný staging / výchozí stav vypnuto.** Tento PR nepřepíná
produkční model, nepřidává UI ani plánování `when`, nespouští migraci a
nezapisuje do žádné databáze.

## Endpoint

`GET /api/target-staging/task-temporal/due-window`

Podporované parametry:

- `scope`: `personal | shared | my-plan`; výchozí `my-plan`
- `window`: povinné `overdue | due-today | upcoming`
- `evaluationDate`: povinný gregoriánský `YYYY-MM-DD`
- `throughDate`: povinný **pouze** pro `upcoming`, 1–90 dní po `evaluationDate`
- `limit`: 1–100, výchozí 50
- `cursor`: volitelný krátkodobý podepsaný token, nikoli syrový offset

Odezva: `{tasks,hasMore,nextCursor,window,evaluationDate,throughDate}`.
Položky jsou jen **otevřené úkoly se společným `dueOn`**. Všechna
odpovědní data podléhají stejnému striktnímu task DTO allowlistu jako R2d.3f,
navíc datovému oknu a přísnému pořadí `dueOn, binary ID`. Nikdy se
nevypisují cizí identifikátory řešitelů, členské role, Area
linearization witness, interní revize, obsah soukromého `when` ani data
z dalších úložišť. `Cache-Control: no-store` vždy platí.

## Bezpečnostní brány a konzistence

Vyžaduje současně doslovnou hodnotu `true` u:

- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_WINDOWS_ENABLED`

Poslední přepínač je nový a nezávislý na status/dueOn write flazích.
HTTP route používá skutečnou autentizaci, izolovaný staging anchor,
kanonicky připnuté čtení a aktuální revokovatelnou session, rate limiting
a omezený child proces s minimálním environmentem. Identity nejsou
převzaté z URL; `sessionTokenHash` je jedinou delegovanou identitou
durable session. Před každou odpovědí se AREA witness synchronně
ověří v živé DB (`verifyStagingReadBeforeRelease`) se session i epochami
oprávnění. Změněné členství/Area znamená `409 read_stale_reload`,
revokovaná relace `401` a neplatný cursor `400`.

Podepsaný cursor obsahuje pouze chráněné údaje o offsetu a revizi
a je krytý oddělenou doménou pro route, identitu/session,
`scope`, `window`, obě datumové hranice, `limit`, generaci a staging.
Nejde o autorizační doklad. Změna dat nebo Area epoch vyžaduje reload
(`409 Cursor stale`); obnovení stránky se nesmí tiše provést na jiných
parametrech. Expirace cursoru je `409 Cursor expired`.

**Datumové označení není automatické tvrzení o aktuálním dni uživatele.**
`evaluationDate` je explicitní filtr zadaný volajícím, nepřebírá se jako
bezpečnostní tvrzení o časovém pásmu, žádná konverze serverových UTC hodin
se zde neprovádí. Budoucí produktové Today musí vyhodnotit datum v
autorizovaně známém časovém pásmu uživatele a teprve potom volat čtení.
Stále zde chybí osobní plánování `when`, snooze, kalendář a kompletní
pohled Today/Upcoming — `due-today` tedy znamená pouze termín `dueOn`
v daném explicitním kalendářním dni, ne celý seznam práce na dnes.

## Testy a uvolnění

`tests/target-staging-temporal-due-window-http.test.mjs` ověřuje výchozí
brány, autentizaci, přísné parametry a 90denní limit,
`my-plan` assignment ACL, shared viewer, skryté soukromé úkoly,
SQL řazení podle data a ID, anti-tamper DTO, přenos cursoru mezi
uživateli/filtry a zneplatnění po změně obsahu, životnost durable session
a živou změnu Area ACL mezi child read a release. Zahrnuto v R2d focused CI.

Před samotným nasazením zůstává povinná samostatná bezpečnostní kontrola,
kompletní Browser E2E na přesném release SHA, kontrola backup/restore
a explicitní schválení cutoveru.
