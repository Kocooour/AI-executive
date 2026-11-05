# R2d.3m.7 — sjednocený globální čtecí model Vše (staging-only)

Navazuje na sloučené interní a HTTP indexy:
[R2d.3m.1–.4 úkoly/projekty](R2D-GLOBAL-PROJECT-HTTP.md) a
[R2d.3m.5–.6 poznámky](R2D-GLOBAL-NOTE-HTTP.md).
**Žádný nový HTTP endpoint ani produkční UI.** Nepovoluje změny
dat, nasazení, migraci, cutover ani zapnutí feature flags.

## Význam Vše

Globální `all` vrací **všechny aktuálně autorizované**
projekty, úkoly i názvy poznámek:
uživatelovy soukromé a všechna čitelná data sdílených Oblastí
i pro roli `viewer`, bez závislosti na tom, kdo má úkol přidělený.
`personal` vrací pouze vlastní soukromá data, `shared` pouze
aktuálně čitelná sdílená data. Tím se Vše liší od výchozího Mého plánu.

`readAuthorizedGlobalCombinedPage` sdružuje tři již revidované
SQL selektory **v jednom transakčním read snapshotu**;
neagreguje tři nezávislé HTTP/child odpovědi, které by vznikaly
za různých oprávnění nebo revizí. Staging facade
`readPreflightedGlobalCombinedPage` nejprve provede kanonický
preflight a ověří serverově podepsaného aktéra.
`TargetStagingSessionAuthority.readGlobalCombinedPage` je
pouze interní serverová brána, nikoliv přijímač HTTP identity.

## Stránkování a DTO

Omezená stránka má `limit=1..100`. Každý dílčí selektor
čte nejvýše `limit+1` již autorizovaných záznamů,
s deterministickým BINARY řazením `id`; při stejném ID
je typové pořadí `project → task → note`.
Vrací se nejvýše `limit` záznamů s diskriminátorem
`kind` a typově odděleným `item`.
Každá položka obsahuje pouze bezpečná metadata daného typu,
**nikdy tělo poznámky, identitu jiného přiřazeného člověka
ani seznam členů**. Prázdné sdílené projekty zůstávají viditelné.

Interní `positions={projects,tasks,notes}` odpovídají počtu
skutečně spotřebovaných záznamů daného typu.
`nextPositions` je vystaveno **jen uvnitř serveru**,
dokud další iterace neimplementuje na HTTP hranici HMAC
actor/session/scope/revision-bound opaque cursor.
Neznámé klíče pozic, necelá či neplatná čísla a překročení
limitu offsetu 1 000 000 se odmítají.
Konec přes více druhů určuje úplná množina kandidátů
a serverové `hasMore` podkladových stran.

## Oprávnění a revize

Všechny tři selektory musí vrátit **shodnou kompletní
množinu svědeckých Area epoch** včetně prázdných Oblastí;
rozdílný actor/scope/ACL snapshot znamená zamítnutí stránky.
Sjednocená revize je oddělený SHA-256 digest
`lumi:r2d:combined-global-index:v1` z aktéra, scope,
restore generation a tří podkladových revizí.
Sleduje tak policy/content/project-content epochy
a také poznámkové `note_sync_revision`.
Vnitřní DTO vrací `linearization`, `areaEpochs`
a `noteAreaEpochs` jako nedůvěryhodné svědectví, které
je stále nutné prověřit **živě před vydáním dat**.

Další HTTP/UI integrace **musí** bezprostředně před
odpovědí ve stejné live SQLite transakci ověřit
identitu a session, úplnou současnou množinu Area ACL,
všechny content/project epochy a `noteAreaEpochs`,
včetně nově přidělených prázdných Oblastí. Bez této
bariéry není dovoleno interní čtecí model zveřejnit.

## Regrese a další práce

`tests/target-global-combined-read.test.mjs` pokrývá
všechny tři entity, viewer i editor, cizí soukromá
data, prázdné projekty, zděděnou Oblast poznámky,
typové kolize ID, BINARY pořadí, kontinuální
stránkování s různými limity, omezení vstupů,
oblastně oddělené revize, změnu těla poznámky,
změnu oprávnění a session, nově získanou
prázdnou Oblast a kompletní živou bariéru.
Test je přidán do cílených R2d regresí.

Další R2d.3m.8: bezpečná HTTP brána pro
**kombinovanou** autorizovanou stránku s
podepsaným kurzorem obsahujícím trojici pozic,
přísným výstupním allowlistem a atomickou
revokační kontrolou. Aktivace klientského
Vše zůstává až na **UI-09/R3** po dokončení
širších bezpečnostních bariér R2d.
