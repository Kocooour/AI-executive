# R2d.4e / BE-17 — bezpečné stránkování stagingového hledání

**Stav:** neaktivní klientská orchestrace nad read-only BE-16/BE-15. Žádná obrazovka ji neimportuje a žádný feature flag se nezapíná. Server zůstává jedinou autoritou oprávnění.

## Co přibývá

`createStagingTitleSearchSession(fetchImpl)` poskytuje explicitní `first({query,scope,limit})`, `next()`, `getSnapshot()` a `reset()`. Používá existující `loadStagingTitleSearchPage` (BE-16), nikoli vlastní HTTP nebo identitu. Každé `first` a `next` spouští **právě jeden** GET s `same-origin`, `no-store` a `redirect:error`; žádné automatické prefetch, retry ani obnovení stale cursoru. Neexistuje trvalá cache, IndexedDB, sdílení mezi taby ani skryté přepnutí produkčního UI.

- Nové `first` okamžitě vyprázdní staré výsledky, zruší běžící požadavek a zvýší generační token. Opožděná odpověď starší generace nesmí obnovit starý obsah.
- `next` lze spustit jen po úspěšné stránce s `hasMore` a platným cursor; souběžné pokračování je odmítnuto. Každý výsledek je kompletně validovaný BE-16.
- Mezi stránkami se navíc kontroluje přísné binární pořadí `(id, kind)`, včetně stejného ID pro různé druhy, a opakování/cyklus cursorů. Poškozené pokračování vymaže **celý** dosavadní seznam.
- Jakákoli chyba pokračování, zejména `401/403`, `409`, offline, invalid DTO, rate-limit, vypršení gate či problém serveru, smaže všechna dosavadní data a cursor. Sám klient nezkouší nový dotaz ani nepřidává výsledky ze staré revize. Jediný zdroj aktuálního prezentačního stavu je `getSnapshot()`; vrací oddělenou kopii pole i položek.
- `reset()` okamžitě vyprázdní session, zruší běžící request a zabrání opožděné odpovědi opět ukázat výsledky. **Budoucí UI jej musí volat při logoutu, změně identity/session, změně kontextu a při unmountu**. Pasivní klient nedokáže sám rozpoznat změnu cookie nebo odvolat kopie dat, které si jiné UI uložilo.
- Nejvýše 1 000 současně podržených výsledků; překročení končí bezpečným vymazáním a `invalid-response` (nikoli částečným potvrzením). Úzký dotaz či serverové filtrování je doporučené; žádné skryté vyhledávání na pozadí.

## Ověření a hranice

`tests/target-staging-title-search-session.test.mjs` testuje pozitivní explicitní více-stránkové načítání, izolaci kopií, přesah druhového pořadí přes stránku, duplicitní/replay cursor a položky, revokaci/409/offline, nový dotaz během starého požadavku, zrušení a souběžné `next`, neplatné `first` a paměťový limit. Tyto testy používají izolovaný `fetch` stub. Samostatné BE-15 integration testy stále pokrývají živý actor/session-bound HTTP → SQLite read model a ACL.

**Neprovádí se:** změna serverové autority, schématu, migrace, produkční aktivace, UI, vyhledávání v obsahu poznámek či AI. Plná browser E2E sada patří k exact-SHA předprodukční release bráně. Před zapojením do UI je třeba zvlášť navrhnout invalidaci při změně session, mapování loading/error stavu a přístupnost; nerecyklovat výsledky z neaktivních sessions.
