# R3-slice / BE-14 — ohraničené streamované JSON čtení Mého plánu

**Rozsah:** pouze klient `fetchMyPlanSlice` ve výchozím vypnutém stagingovém vertikálním řezu **Můj plán** (Dnes/Zítra). Neaktivuje globální Vše, UI-09/R3, zápisy, žádné produkční flags, migrace či deploy.

## Kontrakt
- Dvoudenní čtecí GET nadále používá `credentials:same-origin`, `cache:no-store`, `redirect:error` a stále jen explicitní uživatelský požadavek, bez retry, prefetch a perzistence.
- Úspěšný HTTP JSON obsah je přijat po částech; maximálně **8 MiB skutečně přijatých bajtů před JSON.parse**. Limit zahrnuje platnou dvojici 100+100 úkolů s plně JSON-escapovanými názvy (200 × 4096 znaků). `Content-Length` je jen předběžná kontrola, nikoliv autorita skutečného objemu.
- Striktní inkrementální UTF-8 (`fatal:true`), odmítnutí chybného/velkého `Content-Length`, odmítnutí falešného `no-store` v jiném tokenu nebo citovaném parametru a falešného MIME v parametru `Content-Type`. Při chybě, abortu a odmítnutém HTTP statusu nebo metadatech se stream zruší. Typované `aborted`, `signed-out`, `stale`, `invalid-response` se nemění.
- Předchozí přísný DTO allowlist, actor/Area ACL, podepsaný cursor a live-epoch guard na serveru, hranice Osobní/Sdílené a zákaz dublovaných úkolů zůstávají stejné.

## Regresní testy
Přijetí velké legitimní odpovědi se 200 názvy a escape sekvencemi; padělaná délka a limit, odmítnutý limit v hlavičce, poškozené UTF-8, podvržené cache/MIME hlavičky a okamžité přerušení zablokovaného streamu. Spouští se společně se stávajícími bezpečnostními testy a buildem na přesném SHA v PR Checks.

Bez data cutoveru, resetu, skutečných uživatelů či produkčního nasazení. Full Browser E2E až při schváleném produkčním release.
