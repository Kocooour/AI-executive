# R2d.3k.1 — v21 izolované osobní plánování `when`

**Rozsah:** pouze nové, ručně vytvořené izolované staging SQLite.
Bez HTTP (čtení i zápis), bez UI, migrace či produktové aktivace.
R2d.3j.2 (#220) řeší sdílený deadline `dueOn`, nikoli osobní den plánu.

## Dvě skutečně odlišná datumová pole

- `tasks.due_on` je **sdílený** termín úkolu; role oprávněných členů
  rozhodují, kdo jej může číst a měnit.
- `personal_task_plans.when_on` je **soukromý** kalendářní den konkrétního
  uživatele. Nikdy není sloupcem společného úkolu, jeho změna se neobjeví
  v Area content epoch, společném change logu ani v DTO sdílených úkolů.
  Žádný uživatel nebo AI nesmí z `dueOn` implicitně vytvořit `when`.
- `NULL` datum osobního plánu reprezentuje **absenci řádku**; reset tedy
  znamená vymazání celé vazby uživatel–úkol, nikoliv nulové datum.
  Vyplněná hodnota musí být skutečné datum `YYYY-MM-DD` (roky 0001–9999).

## Oddělení identit a bezpečnost

Nová tabulka `personal_task_plans` má PK `(user_id,task_id)` a
`revision`, index `(user_id,when_on,task_id)` pro budoucí soukromé výběry.
Pro každý účet vznikne nezávislá monotónní `personal_plan_epochs.revision`.
Vlastník soukromé Oblasti smí plánovat své otevřené úkoly; sdílené úkoly
smí plánovat **jen aktuálně přiřazený editor/admin** v dané Oblasti.
Nepřidělený úkol vyžaduje budoucí explicitní příkaz převzetí, viewer
nemůže plánovat ani úkol, který vidí. Cizí plán nikdy není součástí
základních task/detail/Area DTO.

SQLite triggery v rámci stejné transakce:
- zamítají nepovolené vložení/přepis a změnu identity úkolu či uživatele;
- vynucují kapacitu max. 4096 řádků, monotónní revize a zákaz
  `INSERT OR REPLACE` (aby nešlo obejít audit budoucího příkazu);
- aktualizují **pouze soukromý epoch** vlastníka plánu při vložení,
  změně dne a vymazání, včetně návratu k původní hodnotě (ABA);
- odstraňují starý plán při odebrání přiřazení, dokončení, změně
  efektivní Oblasti, revokaci/úpravě členství nebo odstranění úkolu
  (FK cascade). Opětovné přiřazení plán **neobnovuje**.

Kanonický preflight odmítne chybějící uživatelské epochy, plány
neodpovídající aktuálním oprávněním a překročení kapacity. Bezpečnost
předpokládá **kanonickou, připnutou SQLite a důvěryhodnou identitu**.
Samotná přímá raw SQL změna není veřejné API, neověřuje HTTP autentizaci,
idempotenci, actor-bound write receipt ani živou autorizaci před release.

## Žádné implicitní upgrady

`TARGET_STORE_SCHEMA_VERSION = 21`. Existující v20/v19 staging
se automaticky nemigruje — preflight jej odmítne. Pro testy lze
výslovně vytvořit **zcela nový izolovaný adresář**; stávající produkční
databáze, legacy zápisy, přihlašovací relace a offline cache se nemění.
Žádné produkční nasazení, reset nebo cutover z tohoto PR nevyplývá.

## Testy a pokračování

`tests/target-task-personal-when-schema.test.mjs` pokrývá kalendářní
validaci, změny dne, ABA, epochy konkrétního uživatele, zákaz cizích
a nepřiřazených plánů, projektovou dědičnost Oblasti, dokončení,
revokaci člena a očištění při změně přiřazení; dále preflight,
nezměněná legacy data a oddělení od společných task/Area revizí.
Test je zahrnutý do zaměřeného R2d workflow.

**R2d.3k.2:** připnuté actor-authenticated čtení soukromých
`when` s výhradně vlastním DTO, soukromým cursorem a live release
guardem. **R2d.3k.3+:** explicitní idempotentní plánovací write příkaz
`set/clear` s CAS, receipt, atomickou bezpečnostní kontrolou a
samostatným default-off HTTP. Až potom složené Today/Upcoming,
které nesmí zaměňovat soukromý plánovaný den za společný deadline.
