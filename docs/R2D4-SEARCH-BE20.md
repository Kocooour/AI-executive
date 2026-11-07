# R2d.4h / BE-20 — abort před HTTP hlavičkami a uvolnění odmítnuté odpovědi

**Stav:** neaktivní read-only stagingový klient BE-16 až BE-19. Neaktivuje se žádné UI, feature flag, nový endpoint ani produkční autentizace.

## Bezpečnostní kontrakt

`loadStagingTitleSearchPage` nyní při aktivním `AbortSignal` nezůstane čekat na hlavičky, i když adapter `fetch` nedodrží signál a nevyřeší svůj promise. Čekání se ukončí na abortu, vrátí `{ok:false,reason:"aborted"}` a nepokouší se o opakování ani nový kurzor. Jediný explicitní GET si stále zachová `credentials:"same-origin"`, `cache:"no-store"` a `redirect:"error"`. Listener se po vyřešení čekání odpojí. Jestliže opožděný adaptér později vydá odpověď, klient její body zahodí přes `cancel()`; takový výsledek se nesmí vrátit ani obnovit data BE-17 session.

Klient také explicitně ruší body odpovědí odmítnutých před JSON parserem: odhlášení `401/403`, chybný HTTP status, redirect, chybějící `no-store`, neplatné `Content-Type` či abort po vydání hlaviček. Tím se neprodlužuje download neautorizovaného či nadbytečného obsahu. Výchozí limity BE-18 (2 MiB, strict UTF-8) a fail-closed BE-17 session se nemění. Žádný běžící požadavek se neobnovuje sám.

## Testy

`tests/target-staging-title-search-client.test.mjs`: ignorovaný abort při fetch před hlavičkami, dokončení čekajícího výsledku, pozdější `Response.body.cancel()`, nepřijetí odmítnutých statusů/hlaviček a zákaz opakování.

`tests/target-staging-title-search-session.test.mjs`: `reset()` při zablokovaném fetch okamžitě odstraní názvy i kurzor, čekající `next()` se vrátí `aborted`, opožděný stream se zruší a nemůže znovu osídlit session.

Bez aktivace R3/UI-09, bez změny dat, migrace či nasazení. Kompletní Browser E2E až před produkčním nasazením na přesném SHA.
