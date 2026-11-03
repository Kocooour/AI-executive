# R2d.3b — základní inventární přehled Home / Můj plán (default-off staging)

`GET /api/target-staging/home/my-plan` vrací pouze `{counts,truncated}`.
Endpoint je **ve výchozím stavu vypnutý**: vyžaduje současné explicitní
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a nové
`AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED=true`.
Není napojen na produkční UI ani synchronizaci. Odpověď obsahuje
`Cache-Control: no-store`.

Počítané hodnoty, vždy samostatně maximálně **1000**:
- `privateProjects`: všechny viditelné osobní projekty
- `assignedSharedProjects`: sdílené projekty, ve kterých má aktér
  alespoň jeden úkol přiřazený přímo sobě a je současným členem editor/admin
- `privateTasks`: všechny soukromé úkoly (samostatné i uvnitř projektů)
- `assignedSharedTasks`: pouze úkoly přiřazené sobě v aktuálně oprávněné
  sdílené Oblasti s rolí editor/admin (včetně samostatných)

Pole `truncated` je pro každou hodnotu true právě tehdy, když je
skutečný počet **větší než 1000**; takový počet je tedy spodní mez
„1000+“, nikoli nepřesně vydávaný úplný počet. Zpracování každé
kategorie je omezené pomocí `LIMIT 1001`.

Jde výslovně o **inventární počty**, nikoli počet otevřených/aktivních,
dnešních nebo zpožděných úkolů: cílový staging model zatím nemá pole
completion/status a date/due. Samostatný Inbox, Today, Upcoming nebo
pozornostní engine zde nejsou implementovány.

## Bezpečnost

- Identita je pouze ze živé autentizace owner cookie / durable session;
  klient nepředává scope, user, Area, členství ani filtry.
- Ve **stejném připnutém, preflighted SQLite snapshotu** se vybere
  úplná množina aktuálně přístupných soukromých a sdílených Oblastí
  pro daného aktéra a omezené agregáty. Počet Oblastí je limitován.
- Internal child DTO obsahuje jednotné Area epochy a aktuální role.
  Je striktně parsováno, ale nikdy nepublikováno mimo server.
- Před odpovědí se ve **stejné živé transakci** ověří session, současný
  seznam všech oprávněných Oblastí (včetně prázdných a právě přidaných),
  role, policy revize, task content a project content revize.
  Změna nebo ztráta přístupu způsobí 409 reload / fail closed.
- Vnější odpověď nezveřejňuje názvy/ID projektů, úkolů, Oblastí,
  členství, uživatelů ani revizní metadata.
- Žádné migrace, mazání, zapnutí produkce ani změna legacy dat.

Testy `tests/target-staging-project-index.test.mjs` ověřují skutečné
HTTP a synthetic staging SQLite: pět aktérů, soukromí, viewer exclusion,
samostatné úkoly, přidělení, odvolání session, přidání nové prázdné Oblasti
mezi snapshotem a živou kontrolou, změnu tasků, cizí parametry,
přísnou interní DTO a limit 1000. Cílený workflow běží i při změně
nového API a jeho selektoru. Před mergem je nutný čistý code review a
zelený `PR Checks`; úplný Browser E2E je pouze před produkčním releasem.
