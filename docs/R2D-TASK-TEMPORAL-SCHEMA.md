# R2d.3d — v20 základ stavu a termínu úkolů (staging-only)

Po sloučení R2d.3c (#209) mají Home / Osobní / Sdílené / Můj plán
bezpečné inventární počty projektů a úkolů. Aby bylo možné v dalších
iteracích vypočítat **skutečné** otevřené, dokončené, dnešní a nadcházející
úkoly, musí nejdřív existovat kanonická per-task data.

Tato iterace zavádí pouze **schéma v20** na **nově vytvořeném izolovaném
cílovém SQLite store**, nikoliv nové HTTP API, produkční migraci, UI
nebo aktivaci pohledů Today / Upcoming.

## Kanonická sdílená metadata

- `tasks.status`: `'open' | 'completed'`, povinné, výchozí `'open'`.
- `tasks.completed_at_ms`: `NULL` pro `open`, povinný nezáporný
  bezpečný celočíselný UTC epoch-millisecond timestamp pro `completed`.
  Stav a timestamp se mění **atomicky v jediném SQL příkazu**.
- `tasks.due_on`: `NULL` nebo právě jeden **platný ISO kalendářní
  den** `YYYY-MM-DD`. Nejde o UTC okamžik. SQL CHECK odmítá chybné
  formáty, neexistující dny (včetně 29. února mimo přestupný rok)
  a neplatné měsíce. Nový index `tasks_by_due_on_status` je připravený
  pro budoucí výběr otevřených úkolů s termínem.

**Sdílený deadline není soukromý osobní plán.** Individuální `today/when`,
plánované bloky, snooze, připomínky a časová zóna výběru zůstávají
per-user a nejsou ukládány do těchto polí.

## Monotónní revize a bezpečnost

Změny `status`, `completed_at_ms` a `due_on` automaticky spouštějí
stávající `task_revision_bump`: vždy právě jednou zvýší `tasks.revision`,
`areas.content_revision` a navazující Area-scoped `change_log`.
Zápis stejné hodnoty nic nezvýší. Návrat k původní hodnotě (*ABA*)
revizi nevrací zpět. Samotná změna termínu nebo stavu **nezvyšuje**
`areas.project_content_revision`, takže nepotřebně nezneplatňuje
projektový-only index.

Stávající serverové DTO dál vybírají jen explicitně povolená pole.
Tato iterace nevydává tokeny ani oprávnění ke změně nových údajů.
Budoucí *complete/reopen* a *due edit* příkazy vyžadují samostatnou
write-audience autorizaci, current Area ACL, actor-bound CAS, audit,
idempotentní receipt a živou revizi rodiče/Oblasti; bez této brány
se nové údaje neaktivují v HTTP ani UI. Také je třeba při budoucím
příkazu odlišit historickou atribuci dokončených úkolů od oprávnění
aktuálního řešitele po odebrání člena.

V20 se **nikdy nemigruje automaticky z v19**; preflight nepřijímá
starší verzi ani odlišné DDL. Stávající produkční databáze a legacy
úkoly zůstávají nedotčené. Čistý start cílového modelu je oddělený
od produkčního cutoveru, který potřebuje explicitní schválení.

## Ověření a další krok

`tests/target-task-temporal-schema.test.mjs` zakládá pouze syntetické
staging SQLite: testuje default open, nepovolené kombinace stavu a
časového razítka, přestupný den a neplatná data, monotónní revize,
jediný upsert na změnu, ABA, projektové epochy, preflight i zamítnutí
v19 metadata. Cílená `R2d project read regressions` workflow
a plná `PR Checks` běží na aktuálním head.

Navazující iterace: autorizované **čtení otevřených a dokončených úkolů
včetně termínu**, potom oddělené write příkazy a actor-private plánování.
Celé Browser E2E je release gate pouze před produkčním nasazením.
