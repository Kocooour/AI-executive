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

## Následující navazující část

R2d.3k.4b přidá odděleně default-off HTTP preview, PATCH a receipt
reconciliation. Musí zachovat stejný actor/session binding,
CSRF ochranu, live-release kontrolu a minimální výstupní DTO.
Také vyžaduje další negativní HTTP testy a plně zelené CI.
Browser E2E až v samostatné produkční release bráně.
