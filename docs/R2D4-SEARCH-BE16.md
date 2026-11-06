# R2d.4d / BE-16 — bezpečný klientský transport titulkového hledání

**Stav:** samostatná neaktivovaná klientská knihovna; žádná obrazovka ji zatím neimportuje. Navazuje na default-off HTTP endpoint z BE-15 / PR #287.

## Chování

`loadStagingTitleSearchPage({query,scope:"all"|"personal"|"shared",limit,cursor,signal}, fetchImpl)`

- Pro každý výslovně vyvolaný dotaz provede **jediné** `GET /api/target-staging/title-search` se `same-origin` cookie, `no-store`, `redirect:"error"` a volitelným `AbortSignal`. Nevytváří vlastní identitu, nepředává žádné členství, neposílá zápisy a nepokouší se automaticky obnovit starý cursor.
- Dotazy vyhovují 2–80 znakům, 256 bajtům UTF-8, nejvýše 8 slovům a stávající doméně BE-14. Doslovné znaky `%`, `_` ani `!` se v klientovi neinterpretují jako SQL operátory. Rozsahy jsou jen `all/personal/shared`, strana má 1–50 položek, pokračovací cursor pouze povolený HMAC transportní tvar do 4096 znaků. Neplatné vstupy vůbec nespustí HTTP.
- Odpověď musí být `200 application/json`, `Cache-Control: no-store`, bez přesměrování a s **přesnými** klíči `query,scope,items,hasMore,nextCursor`. Původní query/scope se musí shodovat s voláním. Položky obsahují pouze povolené ID, název, druh projektu/úkolu/poznámky, Oblast a volitelný projectId; kontroluje se velikost textu, rozsah, binární pořadí `id` a pořadí druhů při shodném ID, délka stránky a konzistence `hasMore/nextCursor`. Neočekávané interní údaje jsou odmítnuty; klient stále **není autoritou oprávnění**.
- Výsledkem je diskriminovaná unie `{ok:true,page}` nebo `{ok:false,reason}`. Důvody rozlišují odhlášení (401/403), vypršení či zastarání (409), vypnutý endpoint (404), neplatný vstup (400), rate limit (429), offline a abort, špatnou odpověď a jinou nedostupnost.
- Zvláště při `409` se **nesmí připojit další stránka ke starým výsledkům**: případné UI musí zahájit **nové explicitní** načtení první stránky a nahradit starý seznam. Při odhlášení musí skrytá či již neautorizovaná data z UI zmizet. Klient sám drží nulový trvalý cache a automaticky neopakuje žádný request.
- Ovladače v UI mají výhledově využít existující hlavičkový přístup k hledání, nikoli přidávat ikonu do spodní mobilní navigace. Samotná UI integrace, render, loading skeleton, accessibility a případné refetch/autocomplete jsou mimo tento řez.

## Ověření a release hranice

`tests/target-staging-title-search-client.test.mjs` kontroluje plnou sadu validací s izolovaným `fetch` adaptérem: explicitní stránkování, same-origin credentials/cache, správnou strukturu DTO, originální query/scope, neplatná pole a pořadí, podvržené typy, odhlášení, revokaci, 409, 404, 429, síťovou chybu a zrušení požadavku. Předcházející BE-15 ověřuje skutečnou cestu do serverových SQLite handlerů v izolovaném stagingu.

Bez změny produkčního API, autentizace, databázového schématu, UI aktivace, migrace či nasazení. **PR #287 je sloučen v `main` jako BE-15 (`78dc5c23`)**; toto klientské rozhraní zůstává neaktivní a případné zapojení do UI vyžaduje samostatné review a stagingový přepínač; žádný staging flag se tímto PR nezapíná. Browser E2E zůstává release bránou R4.

## Bezpečné ověřování HTTP hlaviček (navazující P2 oprava)

Klient přijme `200` JSON stránku pouze pokud `Content-Type` uvádí **přímo MIME typ** `application/json` (bez ohledu na velikost písmen, povoleny běžné parametry jako `charset=utf-8`) a `Cache-Control` obsahuje **samostatnou direktivu** `no-store`. Nepostačuje výskyt podřetězce: `x-no-store`, `no-store=1`, `private="...,no-store,..."` ani `text/html; charset=application/json` nejsou důkazem splnění kontraktu. Uvedené odmítnutí vrací `invalid-response` a nespouští opakování požadavku. Přidány regresní testy chybných i platných kombinací; serverový gate, ACL, UI a produkční nastavení se nemění.
