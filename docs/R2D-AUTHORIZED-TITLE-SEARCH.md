# R2d.4a — izolované autorizované vyhledávání podle názvu (staging-only)

Navazuje na sloučené kombinované **Vše / Osobní / Sdílené** indexy
[R2d.3m.7–.8](R2D-GLOBAL-COMBINED-HTTP.md). Dodává pouze **interní
serverový read model** pro názvy projektů, úkolů a poznámek, nikoli
vyhledávání v tělech poznámek, AI kontextu nebo přílohách.
Není HTTP endpoint, UI-09/R3, produkční aktivace, migrace ani nasazení.

## Bezpečnostní kontrakt

Serverová authority metoda `readAuthorizedTitleSearchPage` přijímá
důvěryhodného aktéra, scope (all/personal/shared), query, limit a offset.
Aktér se **nikdy** nepřebírá přímo z klientského požadavku. Authority
vydá jednorázové podepsané oprávnění, facade provede kanonický preflight
a aktéra ověří v jednom připnutém SQLite snapshotu.

Jedna parametrizovaná SQL operace filtruje soukromé vlastnictví a
současné sdílené členství viewer/editor/admin před hledáním a
LIMIT/OFFSET. Úkol či poznámka v projektu dědí jeho Oblast. Globální
all obsahuje všechny aktuálně čitelné položky, nikoli jen přiřazené
úkoly Mého plánu. Nepublikují se cizí osobní názvy, těla poznámek,
cizí identity, assignee ani seznamy členů.

Query je trimovaný kanonický UTF-8 text 2–80 znaků, maximálně 256 B,
bez řídicích znaků a neplatných surrogátů. Znaky %, _ a ! jsou
v SQL LIKE escapované jako doslovné. Vestavěné SQLite LIKE skládá
velikost písmen pouze pro ASCII, nejde o univerzální fulltext.

Vrací se pouze typ, ID, název, efektivní Oblast a případný projectId.
Deterministické řazení ID BINARY, při shodě ID typy
project → task → note. Limit 1–50, offset 0–1 000 000.
Interní nextOffset není veřejný podepsaný kurzor.

Každá stránka obsahuje neveřejný actor-bound digest z dotazu, scope,
restore generace, **všech** policy/content/project-content epoch
čitelných Oblastí a note_sync_revision (včetně prázdných Oblastí).
Interní linearization, areaEpochs a noteAreaEpochs slouží jako
svědectví pro živou revokační bariéru, nesmí opustit server.

## Povinné další bezpečnostní brány

Případný HTTP adaptér musí být default-off, použít samostatný
izolovaný bounded child, explicitní současnou session/identitu,
podepsaný actor/session/query/scope/revision-bound kurzor,
přísný DTO allowlist, rate-limit a především **atomický LIVE
guard** všech Area ACL/content/project-content a note-sync epoch
bezprostředně před vydáním výsledků. Při revokaci/restore/stale
nesmí vydat žádné částečné tituly. Tento PR HTTP neimplementuje.

`tests/target-authorized-title-search.test.mjs` pokrývá různá
oprávnění, prázdné projekty, děděné Oblasti, body-leak,
literal LIKE wildcards, BINARY stránkování, chybný vstup,
podepsanou authority, body-only note epoch, nově zpřístupněnou
prázdnou Oblast a revokace členství/session. Plné browser E2E
je brána až před produkčním releasem.
