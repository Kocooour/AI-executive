# R3-FE-05 — autorizované Hledání v hlavní aplikaci

**Milestone:** R3 — uživatelsky dostupný serverový seznam názvů, bez legacy příměsí. Toto je první UI integrační krok, nikoli plná obsahová/AI/externí globální search.

## Akceptační tok

1. Po explicitním zapnutí `AI_EXECUTIVE_TARGET_UI_ENABLED`, cílového HTTP, globálních scopes, `AI_EXECUTIVE_TARGET_UI_TITLE_SEARCH_ENABLED` a `AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED` otevře uživatel přes **horní vyhledávací pole** obrazovku Hledání (spodní mobilní menu neměníme). Klient vyžaduje známou serverově potvrzenou generaci přihlášení.
2. Po zadání 2–80 znaků (maximálně osm slov) a stisku tlačítka **Vyhledat** načte jednu stránku přes existující `GET /api/target-staging/title-search`. Nehledá automaticky po každém znaku, nepřidává legacy výsledky, neprovádí klientské předstírání oprávnění. Každé Načíst další znovu ověří ACL na serveru a nahradí staré výsledky pouze po úspěšné odpovědi.
3. Jediný globální přepínač **Vše / Osobní / Sdílené** používá stejný URL stav jako Projekty a Můj plán. Přepnutí, úprava dotazu, změna generace identity nebo odchod z obrazovky odstraní původní názvy/počty okamžitě, i když se vrátí opožděná odpověď. Skrytí/blur/pagehide, skutečný BFCache pageshow a offline také skryjí výsledky. **Úspěšný periodický tick autorizace i neúspěšná revalidace (včetně 503/timeoutu) skryjí všechny dosavadní názvy a počty i při nezměněné přihlašovací generaci** (např. po odebrání členství ve sdílené Oblasti); pending odpovědi se zneplatní. Po neúspěšné revalidaci se vyhledávání zablokuje až do dalšího úspěšného ověření a uživatel musí zadat nový výslovný dotaz. Žádné automatické opakované hledání. Žádný title/actor/Area se nepersistuje.
4. Uživateli se ukazuje druh Projekt / Úkol / Poznámka a rozlišení soukromá/sdílená položka textem i barvou, bez těla poznámky; klidný prázdný stav, chyba, rate-limit, nedostupná relace a limit 1000 položek. Čeština i angličtina a rozložení 390 px/desktop.
5. Když je flag vypnutý, dosavadní legacy vyhledávání běží beze změny. Pouze aktuálně zapnutý a serverově autorizovaný cílový search používá novou komponentu. V autorizovaném Hledání se vůbec nemontuje původní `EntityList` (lokální úkoly) ani `HeldBack` (lokální zadržené názvy), a to ani před prvním hledáním, během načítání, stránkování či při chybě. Uživatel nikdy neuvidí současně legacy a target výsledky.

## Bezpečnostní a produktové hranice

- UI flag není ACL. Server autorizuje každou položku dle aktuální identity, členství, Oblasti a revize; při neověřené/pozdní odpovědi klient vždy skrývá celý výpis.
- Tento krok úmyslně nabízí **jen titulkové výsledky pro čtení**. Otevření projektu/úkolu/poznámky přímo z hledání je další integrační krok, který musí samostatně napojit typované adresy a vždy nově autorizovaný detail. Nevyvářet neověřená deeplinková tlačítka.
- Nevyhledává tělo poznámky, kontextové claimy, Gmail ani externí data; žádné nové HTTP routy, zapisovače, sdílení, reálný HumanWiki import ani R4 cutover.
- Žádná produkční aktivace; plná Browser E2E nad přesným release SHA zůstává samostatnou podmínkou nasazení.

## Ověření

Jednotkové testy: `node --experimental-loader ./tests/ts-loader.mjs --test tests/target-main-title-search-ui.test.mjs` a navazující staging search/session testy. PR Checks/typecheck/build běží nad přesným HEAD.

**Povinné cílené browserové ověření R3-FE-05:** `.github/workflows/focused-r3-main-title-search-browser.yml` spouští **dva izolované Playwright joby** (`LUMI_TARGET_MAIN_SEARCH_MODE=on/off`) nad `e2e/target-main-title-search.spec.ts`, vždy na **390 a 1280 px**. Test skutečně spustí hlavní React obrazovku, založí validní lokální legacy úkol a nesynchronizovatelný záznam s dlouhým názvem do IndexedDB a ověří jejich reálné zobrazení před přechodem do Hledání. V cílovém režimu musí být oba názvy a řádky nepřítomné před dotazem i po Enter, stránkování a změně rozsahu; test kontroluje i bezautomatické načítání, serverové odpovědi a vymazání při neúspěšné revalidaci stejné generace. V režimu vypnutého UI flagu musí staré Hledání nad stejnými lokálními záznamy zůstat funkční a nesmí vzniknout target runtime ani HTTP dotaz.

HTTP cílové search/session odpovědi jsou syntetické a zachycené Playwrightem před přístupem ke staging backendu. Běží pouze lokální dočasná testovací instance s novým heslem/session secret a dočasnou databází; žádné produkční zapnutí ani změny reálných dat. Plná neomezená Browser E2E sada je až release gate nad přesným produkčním SHA.
