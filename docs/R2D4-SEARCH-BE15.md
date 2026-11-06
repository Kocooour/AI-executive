# R2d.4c / BE-15 — stagingové autorizované HTTP vyhledávání

**Stav:** nový, výchozím nastavením vypnutý stagingový endpoint; nikoli aktivované uživatelské ani produkční vyhledávání. Navazuje na R2d.4a/4b (interní titulkové hledání).

## Kontrakt

`GET /api/target-staging/title-search?q=Shared+project&scope=all&limit=50`

- Výchozím nastavením vypnuto: vyžaduje zároveň `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a nový samostatný `AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED=true`. Žádná z hodnot se nezapíná instalací ani mergem. Nepřepíná běžné UI na cílové R3.
- Povinné `q`: 2–80 znaků, maximálně 256 UTF-8 bajtů, 1–8 slov. Shoda všech slov v názvu **téže** položky v libovolném pořadí, nikoli v obsahu poznámek. Stávající SQL Area ACL a doslovné `LIKE` escapování z BE-14 zůstávají autoritativní.
- `scope=all|personal|shared` (výchozí `all`) znamená pouze **autorizované** projekty, úkoly a poznámky aktuální identity. Jde o serverový význam `Vše`, nikoli o `Můj plán`; nepřiřazené sdílené úkoly jsou pro oprávněné členy dohledatelné.
- `limit=1..50` (výchozí 50) platí na stránku, `cursor` je nepovinný. Neznámé či duplikované parametry, chybná struktura query/cursor nebo překročení limitů se odmítnou `400`. Odpověď: `{query,scope,items,hasMore,nextCursor}`; každý `item` obsahuje jen `{kind,id,title,areaId,areaKind}` a u úkolu/poznámky `projectId`. Žádný obsah poznámky, identita aktéra, členství, privátní epochy, interní revize ani kurátorové oprávnění se neserializují. Každá odpověď používá `Cache-Control: no-store`.
- HMAC cursor s nejvýše 15minutovou životností je svázaný s autentizovanou session/cookie, skutečnou identitou, přesným `q`, `scope`, `limit`, staging adresářem a restore generation. Nová stránka vyžaduje živou autorizační preflight kontrolu a shodu kompletní revize. Cizí session, dotaz, rozsah nebo limit znamená `400`; změna Area/content/project-content/note-sync epochy mezi stránkami znamená `409` a bezpečné načtení od první stránky.
- Vlastní hledání běží v krátkém izolovaném podprocesu: worker znovu ověřuje durable identitu a stávající autorizovaný SQL read model čte z jediného kanonicky preflightovaného snapshotu. HTTP proces přijímá jen striktně validované DTO (včetně úplného přístupu Area a note epoch witness, i pro prázdné Oblasti), a **bezprostředně před vydáním výsledků** znovu atomicky kontroluje živou session, Area přístup, policy/content/project epochy a note-sync epochy. Revokace znamená `401` či fail-closed, změna obsahu `409 read_stale_reload`; žádný starý titul se nevydá.
- Bezpečnostní brány: existing store anchor check, session admission check, 60 requestů/10 minut na klienta pro tento endpoint, bounded child, 404 pokud je funkce vypnutá, 503 při chybném staging store/child. Žádný uživatelem zadaný `actorUserId`, SQL nebo časové parametry.

## Testy a hranice

`tests/target-authorized-title-search.test.mjs` přidává end-to-end HTTP volání nad izolovaným syntetickým SQLite store (včetně reálných durable sessions, actor-scoped child, HMAC cursoru, role viewer/editor, privátních a skrytých Oblastí, note-body-only editace, revokace session a podvrženého worker DTO). Testy ověřují i `no-store` a zákaz interních polí v odpovědi.

Aktuální desktopové UI-06c/UI-06d změny se integrují nezávisle; tento endpoint **nemění** jejich obrazovky, focus management ani výchozí navigaci. Před sloučením je potřeba ověřit CI na aktuálním integrovaném `main`.

Bez produkční migrace, deploymentu, aktivace flagů, UI komponenty, indexace obsahu, přihlašovacích změn či vyhledávání přes AI. Plné browser E2E, VoiceOver/mobilní náhled, restore a souhlas s produkčním cutoverem zůstávají výhradně v samostatné release bráně R4.
