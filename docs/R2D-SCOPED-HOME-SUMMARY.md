# R2d.3c — autorizované inventární počty Home ve třech rozsazích

Nový **staging-only, default-off** endpoint:

`GET /api/target-staging/home/summary?scope=personal|shared|my-plan`

Bez parametru `scope` platí `my-plan`. Endpoint je dostupný pouze při
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` **a**
`AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED=true`.
Nezasahuje do produkčního UI, nezapíná synchronizaci a nemění schéma.

Vnější odpověď má přesný tvar
`{scope, counts:{projects,tasks}, truncated:{projects,tasks}}`.
Každá metrika je omezená na 1000 a nad limitem má `truncated=true`
(znamená **1000+**, nikoli přesný počet). `Cache-Control: no-store`.

## Rozsahy

- **Osobní:** všechny projekty a úkoly v aktuálně přístupných *vlastních
  soukromých* Oblastech, včetně úkolů uvnitř projektů.
- **Sdílené:** všechny projekty a úkoly ve sdílených Oblastech s aktuálním
  členstvím **viewer, editor nebo admin**, včetně nepřidělených úkolů a práce
  ostatních členů. Samostatné sdílené úkoly se také počítají.
- **Můj plán:** všechny vlastní soukromé projekty a úkoly plus sdílené
  projekty s alespoň jedním úkolem přiděleným právě aktérovi a
  jednotlivé sdílené úkoly přidělené právě aktérovi, za podmínky
  současné role **editor/admin**.

`GET /api/target-staging/home/my-plan` z předchozí iterace zůstává
zachován beze změny, včetně jeho čtyř metrik.

**Pozor:** jsou to pouze inventární součty. Dokončení úkolu, Inbox,
Today, Upcoming, termíny a attention engine zůstávají neimplementované,
protože canonical staging schéma ještě neobsahuje jejich stav ani data.

## Hranice bezpečnosti

Identita je vždy odvozena serverem z autentizované owner cookie nebo živé
durable session. Klient smí volit **jen jeden ze tří předem určených
rozsahů**, žádné ID aktéra, Oblasti, členství nebo project/task selector.

Ve stejném preflightovaném SQLite snapshotu vzniká výčet **všech
oprávněných Oblastí daného rozsahu** (včetně prázdných) a dva omezené
agregáty. Izolovaný child vrací obsahově prázdné counts plus interní
ACL/Area epochy; přísná allowlist validace nepovolí další metadata.

Před odesláním v **jedné živé transakci** server znovu ověří session,
aktuální členství/role, policy, kompletní množinu oprávněných Oblastí
a obsahové/projektové revize. Nově přidaná nebo odebraná přístupná Oblast,
přesun či úprava projektu/úkolu, změna přiřazení a revokace přístupu
zastaví vydání zastaralého souhrnu. HTTP nevrací ID, názvy, osoby ani
interní oprávnění a revizní data.

Syntetické testy `tests/target-staging-project-index.test.mjs` ověřují
pět autentizovaných identit, sdílený viewer přístup, nesdílení soukromí,
samostatné úkoly, scope odmítnutí, revokaci, závody mezi snapshotem
a vydáním, nové prázdné Oblasti, striktní DTO a limit 1000+.
Cílená CI workflow sleduje nový route glob, selector i child.
Úplné Browser E2E se spouští až jako gate před produkčním nasazením.
