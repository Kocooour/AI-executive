# R2d.3k.4a — interní zápis osobního plánovaného dne

**Izolovaný v21 staging, pouze serverová knihovna.** Žádné HTTP,
UI, výchozí aktivování, migrace ani produkční nasazení.

## Příkaz

`TargetStagingSessionAuthority.changePersonalWhen(writeSession, command,
durableSessionTokenHash?)` provádí jeden atomický `set/clear`
pouze pro **aktuálně ověřeného aktéra**. Aktér se v těle příkazu
nezadává. Je vyžadováno přesně osm údajů:

- `commandId` (UUID v1–v8), `taskId` (kanonické ID úkolu),
- `whenOn` (striktní gregoriánské `YYYY-MM-DD`; `null` = smazání),
- `expectedRevision` (task/Area/restore CAS z autorizovaného preview),
- `expectedPrivateEpoch` (monotónní epocha soukromého plánu aktéra),
- `expectedPlanRevision` (revize jeho konkrétní položky nebo `null`),
- `writeAreaId` (Area skutečného úkolu),
- `restoreGeneration` (aktuální generace izolovaného stagingu).

Příkaz vrací pouze `{ok:true}` nebo `{ok:true,replayed:true}`;
negativní výsledky jsou obsahem nesdělující chybové kódy. Tato
interní API není HTTP endpoint. Epocha plánu se nesmí posílat
neautorizovaným klientům.

## Bezpečnost a idempotence

Prostřednictvím již zavedené pinned/preflighted `BEGIN IMMEDIATE`
transakce se po ověření zápisové session kontroluje restore
generation, aktuální Area write ACL a přesné Area úkolu.
U sdíleného úkolu je **navíc nutné, aby byl právě přiřazen aktérovi**;
viewer a ne-přiřazený editor nesmějí změnit jeho osobní plán.
Úkol musí být otevřený. Všechny tyto kontroly probíhají ještě
před vyhledáváním receipt a znovu i pro opakovaný příkaz.

Nový receipt prefix má vlastní kapacitu a HMAC-neobsahující
SHA-256 identifikátor vázaný na aktéra, úkol a command UUID.
Digest zahrnuje všechny parametry příkazu; opakování stejného
příkazu je úspěšné bez další změny epochy. Změna payloadu pod
stejným UUID je konflikt. Před samotným zápisem se kontrolují
tři nezávislé revize, dostupnost pinned inode, absence SQLite
sidecar souborů a stav durable session.

Vložit, upravit či smazat lze **jen řádek `personal_task_plans`
daného aktéra**; kanonické SQL triggery mění jeho soukromou
epochu. Nesmí se změnit sdílený `dueOn`, stav úkolu ani jeho
task/Area content epoch. Commit je doprovázen append-only
auditním intentem `personal_when`, který obsahuje jen hash receipt,
novou epochu a informaci set/clear — nikoli datum, identitu či ID.

## R2d.3k.4b — default-off staging HTTP

`GET /api/target-staging/task-temporal/personal-when/command?taskId=...`
vrací pouze `expectedRevision`, `expectedPrivateEpoch`,
`expectedPlanRevision`, `whenOn`, `writeAreaId` a
`restoreGeneration`. Jediný izolovaný child načte všechny
hodnoty ze stejného preflightovaného snapshotu aktuálního
oprávněného aktéra. Název úkolu, cizí plán ani interní
`linearization`/`guard` nikdy nejsou ve veřejné odpovědi.
Bezprostředně před odpovědí se ověří aktuální session,
Area/policy, task/parent revision a soukromá epocha.

`PATCH /api/target-staging/task-temporal/personal-when/command`
přijímá výhradně osm polí interního CAS příkazu; kontroluje
stejný Origin, protokol, velikost, limiter, přístup a aktuální
konfiguraci. Rozhodnutí o commit a opakování příkazu provádí
pouze krátkodobý child v jedné `BEGIN IMMEDIATE` transakci.
Pro durable staging sessions je *hash aktuální session* předán
dítěti a znovu ověřen pod zámkem před commit. Nevrací task
data, osobní den ani actor ID, pouze `{ok:true}` nebo
`{ok:true,replayed:true}`, případně bezpečné chyby.

`POST /api/target-staging/task-temporal/personal-when/command/receipt`
je read-only ověření nejasného výsledku příkazu, přijímá
přesně stejný příkaz (včetně ID a původních revizí). Receipt
lze vyhledat **jen s aktuálním právem zapisovat daný úkol
a aktuálním vlastním přiřazením**; HTTP release opět ověří
zabezpečený snapshot. Vrací pouze
`{status:"committed"|"not_recorded"}`; konflikt nevrací
obsah receipt.

**Všechny čtyři flagy musí být explicitně `true`:**

- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED`

Výchozí stav je vypnuto; žádné produkční přepnutí, UI, migrace
nebo napojení na legacy databázi. Browser E2E zůstává samostatnou
bránou před produkčním releasem.
