# R3-slice UI-04a — bezpečný klientský transport osobního „Kdy“ (Dnes/Zítra)

**Stav:** pouze nový izolovaný klientský modul s testy. **Žádné UI jej zatím nevolá**, žádná změna serverových endpointů, produkčních dat ani feature flagů. Navazuje na sloučenou UI-03b/#267 (bezpečné dokončení a Undo) a existující R2d.3k.4b staging personal-when HTTP.

## Osobní plán, nikoli společný termín

- `whenOn` je **vlastní plán právě přihlášeného aktéra**. Změna nesmí přepsat společné `dueOn` ani osobní plány jiných lidí. Soukromou epochu, oprávnění k Oblasti a přiřazení sdíleného úkolu ověřuje vždy serverový pinned writer, nikdy klientský DTO.
- `myPlanWhenTarget(evaluationDate, "today"|"tomorrow")` pracuje s kalendářním datem z lokálního výběru přehledu; žádné přičítání 24 hodin k timestampu. Podporuje skutečný gregoriánský kalendář a konce měsíců/roku včetně přechodů letního času.
- `prepareMyPlanWhen` při **každé** žádosti načte znovu aktuálně autorizované `GET /api/target-staging/task-temporal/personal-when/command?taskId=...`, vyžaduje `Cache-Control: no-store`, exact šestipolový snapshot: `expectedRevision` (SHA), `expectedPrivateEpoch` (nezáporné bezpečné celé číslo), `expectedPlanRevision` (bezpečné celé číslo nebo `null`), `whenOn`, `writeAreaId`, `restoreGeneration` (UUID).
- Při odlišné Oblasti, revizi, chybějícím parametru, neznámém actor poli či neplatném datu funkce **odmítne zápis**. Stejný již nastavený den vrací `unchanged`; nic se neodesílá.
- `dispatchMyPlanWhen` smí odeslat **právě jeden** `PATCH /.../personal-when/command` se striktně **osmi** poli `{commandId,taskId,whenOn,expectedRevision,expectedPrivateEpoch,expectedPlanRevision,writeAreaId,restoreGeneration}`; používá same-origin, no-store, `x-lumi-target-protocol: 1` a implicitní Origin prohlížeče. Bez actor ID nebo klientských rolí.
- Jediný jistý úspěch je 200 se striktně validním `{ok:true}` / `{ok:true,replayed:true}` nebo potvrzené `receipt:committed`. 400/409 z PATCH jsou definitivní odmítnutí. 401/403/404 **po odeslání** mohou nastat i po skutečném commitu a nejsou důkazem rollbacku. Síťový výpadek, timeout, 503, chybné 200 a abort po zahájeném PATCH jsou **nejisté**; pouze `POST /.../personal-when/command/receipt` s **původním totožným osmipolovým příkazem** může potvrdit `committed`. `not_recorded` není záruka, že pozdní commit nikdy nenastane.
- **Není žádný automatický retry PATCH**, offline queue, service worker, localStorage, sessionStorage ani IndexedDB. Po nejistém příkazu musí navazující UI blokovat další mutace a nabídnout pouze ruční read-only receipt; po potvrzeném úspěchu znovu načíst serverový My Plan. Reverzní přesun / smazání `whenOn` je **nový** příkaz po novém snapshotu, s novým UUID i novými private epoch/CAS hodnotami.

## Výchozí bezpečnostní brány a následující UI-04b

Existující serverová API jsou default-off a vyžadují všechny čtyři hodnoty doslova `true`: `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED`. Tento PR je **nenastavuje** a nezapojuje do produkčního UI.

Další UI-04b přidá **samostatnou default-off serverovou bránu pro vykreslení „Kdy“**, spřáhne ji s těmito čtyřmi endpoint flags a existujícím read-only Mým plánem. Musí mít pending/offline/konflikt/nejistý výsledek a actor-bound potvrzení, zachovat skrytí dat při revokaci a v žádném případě nekolidovat se status dokončením/Undo z UI-03b. Čitelný stav bez autorizace zůstane read-only; kliknutí na Dnes/Zítra nebude změnou společného termínu.

## Testy a release gate

`tests/target-staging-my-plan-when-client.test.mjs` vykonává syntetické GET/PATCH/receipt scénáře, datumovou validaci a DST, soukromé epochy, revizi plánu, klientský exact contract, 401/403/409/503, `not_recorded`, ztracenou odpověď po možném commit, abort, nové CAS pro clear/Undo a izolaci od produkčního/staging UI. Testy jsou bez reálného zápisu do databáze; serverové ACL/write testy již existují v R2d.3k.4b.

Před jakýmkoli produkčním releasem zůstávají povinné full browser E2E na **přesném release SHA** včetně změny identity, offline, mobile/desktop a restore generation; bez samostatného schválení není povolen cutover, reset, migrace ani produkční nasazení.
