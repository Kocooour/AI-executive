# R2d.4g / BE-19 — přerušitelné streamování a HTTP integrační bariéra vyhledávání

**Stav:** pouze staging, výchozím nastavením vypnuté hledání. Žádná aktivace UI, změna API, schématu, produkčních oprávnění ani migrace.

## Problém a oprava

BE-18 omezil počet přijatých bajtů, ale běžící `reader.read()` mohl při zcela zastaveném streamu čekat i po zavolání `reset()` nebo abortu, pokud producent streamu nepředával signál dál. BE-19 registruje krátkodobý `AbortSignal` listener přímo u aktivního readeru; abort zruší stream a tím uvolní čekající čtení. Listener se vždy odpojí při dokončení/odmítnutí. Stávající typované výsledky `aborted` a `invalid-response` se nemění; síťový `fetch` nadále dostává stejný `signal`. Bez přednačítání, retry, background požadavků či perzistentní cache.

## Ověření

- Izolovaný klientský test zastaví stream uprostřed `pull()`, vyvolá abort a kontroluje, že pending operace skončí `aborted`, stream dostane `cancel()` a nic se nezobrazí.
- Test BE-17 session ověří, že `reset()` během zablokovaného pokračování okamžitě vyprázdní tituly/cursor a dokončí čekající `next()` bez obnovení staré generace.
- Živý stagingový integrační test volá skutečný `GET /api/target-staging/title-search` nad izolovaným syntetickým SQLite store prostřednictvím BE-16 klienta a BE-17 session. Ověřuje podepsaný cursor, příslušnost k aktérovi a Oblasti, změnu pouze obsahu poznámky (409), revokaci durable session (401), vymazání seznamu a reset před změnou identity; cizí soukromé tituly se nesmí objevit.

Veškeré testy používají syntetická data. Neprovádí se produkční deploy, zapnutí stagingového flagu v aplikaci, UI-09/R3, data cutover ani plná Browser E2E (ta zůstává bránou před nasazením na přesném SHA).
