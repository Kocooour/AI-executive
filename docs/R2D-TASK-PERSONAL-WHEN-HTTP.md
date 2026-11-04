# R2d.3k.3 — samostatně vypnuté HTTP čtení osobního `when`

**Pouze v21 izolovaný staging.** Žádný zápis, UI, automatický upgrade,
změna produkce ani aktivace nové funkce.

## Endpoint

`GET /api/target-staging/task-temporal/personal-when`

Parametry: povinné `window=all|on-day|upcoming`, `evaluationDate`
povinné pro `on-day` a `upcoming`, `throughDate` povinné **pouze**
pro `upcoming`, striktně 1–90 dní za `evaluationDate`.
`all` nepřijímá ani jedno datum. Volitelný `limit` 1–100
(výchozí 50) a `cursor` (nikoli surový offset). Nejsou přijímány
žádné parametry `actor`, `userId`, Oblast nebo role.

Výstup obsahuje pouze
`{plans:[{taskId,whenOn,revision}],hasMore,nextCursor,window,evaluationDate,throughDate}`.
Nenese identitu uživatele, název úkolu, společný termín `dueOn`,
obsah jiných uživatelů, Area witness, soukromou epochu ani stránkovací
revizi. `Cache-Control: no-store`.

Kalendářní datum volí volající explicitně. Server zde **nepředpokládá**,
že systémové UTC datum je lokální dnešek uživatele. Budoucí UI musí
vyhodnotit `evaluationDate` ve správném uživatelském časovém pásmu.

## Obrana v několika vrstvách

Výchozí stav je 404; zapnutí vyžaduje **oba** doslovné `true`:
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED`

Tento flag je nezávislý na společném `dueOn` API i write endpointech.
Route nejprve ověřuje staging anchor, identitu a aktivní session;
nepřijímá actor ID z URL. Subprocess dostane pouze hash session,
nikoli její raw token. Následuje kanonický pinned preflight a
actor-bound serverové čtení (R2d.3k.2), SQL ACL a SQL filtr **před**
LIMIT/OFFSET.

Child DTO parser striktně ověřuje klíče, datové okno, pořadí
`whenOn ASC, taskId COLLATE BINARY ASC`, délku stránky, soukromé
revize a Area witness. Neznámá pole nebo neodpovídající data
nepředává dál.

Podepsaný HMAC cursor je navázán na konkrétní:
staging adresář, restore generation, owner cookie či durable session,
endpoint (oddělená kryptografická doména), window, obě data a limit.
Není autorizačním důkazem. Po změně soukromé epochy nebo Area role
vrátí další stránka 409; neplatný cursor 400, expirovaný 409.
Před každým úspěšným HTTP vydáním se **v jediné živé databázové
transakci** kontroluje aktuální session, identita, Area role/policy
a soukromá epocha. Revokovaná session nesmí dostat žádný obsah.

## Ověření a další krok

`tests/target-staging-personal-when-http.test.mjs` kontroluje
nezávislé default-off přepínače, auth, přísné datumové hranice a
neznámé/duplicitní parametry; izolaci owner/editor/viewer,
projektovou dědičnost, třídění podle dne před ID, stránkování,
HMAC cursor anti-replay a filter-binding, soukromou epochu,
živou revokaci a odmítání podvržených child DTO.

Před produkčním cutoverem je nutné samostatné schválení, bezpečnostní
review a browser E2E na přesném release commitu. Tento PR nic
neaktivuje ani nenasazuje.

**Následuje R2d.3k.4:** idempotentní osobní plánovací příkaz
`set/clear whenOn` s CAS, atomickou autorizací, write receipts,
vlastní revizí a samostatným staging gate. Později složení
Today/Upcoming se společným termínem, kalendářem a pozorností.
