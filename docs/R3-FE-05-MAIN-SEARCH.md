# R3-FE-05 — autorizované Hledání v hlavní aplikaci

**Milestone:** R3 — uživatelsky dostupný serverový seznam názvů, bez legacy příměsí. Toto je první UI integrační krok, nikoli plná obsahová/AI/externí globální search.

## Akceptační tok

1. Po explicitním zapnutí `AI_EXECUTIVE_TARGET_UI_ENABLED`, cílového HTTP, globálních scopes, `AI_EXECUTIVE_TARGET_UI_TITLE_SEARCH_ENABLED` a `AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED` otevře uživatel přes **horní vyhledávací pole** obrazovku Hledání (spodní mobilní menu neměníme). Klient vyžaduje známou serverově potvrzenou generaci přihlášení.
2. Po zadání 2–80 znaků (maximálně osm slov) a stisku tlačítka **Vyhledat** načte jednu stránku přes existující `GET /api/target-staging/title-search`. Nehledá automaticky po každém znaku, nepřidává legacy výsledky, neprovádí klientské předstírání oprávnění. Každé Načíst další znovu ověří ACL na serveru a nahradí staré výsledky pouze po úspěšné odpovědi.
3. Jediný globální přepínač **Vše / Osobní / Sdílené** používá stejný URL stav jako Projekty a Můj plán. Přepnutí, úprava dotazu, změna generace identity nebo odchod z obrazovky odstraní původní názvy/počty okamžitě, i když se vrátí opožděná odpověď. Skrytí/blur/pagehide, skutečný BFCache pageshow a offline také skryjí výsledky. **Úspěšný periodický tick autorizace v target runtime skryje všechny dosavadní názvy a počty i při nezměněné přihlašovací generaci** (např. po odebrání členství ve sdílené Oblasti); pending odpovědi se zneplatní a uživatel musí zadat nový výslovný dotaz. Žádné automatické opakované hledání. Žádný title/actor/Area se nepersistuje.
4. Uživateli se ukazuje druh Projekt / Úkol / Poznámka a rozlišení soukromá/sdílená položka textem i barvou, bez těla poznámky; klidný prázdný stav, chyba, rate-limit, nedostupná relace a limit 1000 položek. Čeština i angličtina a rozložení 390 px/desktop.
5. Když je flag vypnutý, dosavadní legacy vyhledávání běží beze změny. Pouze aktuálně zapnutý a serverově autorizovaný cílový search používá novou komponentu. Uživatel nikdy neuvidí současně legacy a target výsledky.

## Bezpečnostní a produktové hranice

- UI flag není ACL. Server autorizuje každou položku dle aktuální identity, členství, Oblasti a revize; při neověřené/pozdní odpovědi klient vždy skrývá celý výpis.
- Tento krok úmyslně nabízí **jen titulkové výsledky pro čtení**. Otevření projektu/úkolu/poznámky přímo z hledání je další integrační krok, který musí samostatně napojit typované adresy a vždy nově autorizovaný detail. Nevyvářet neověřená deeplinková tlačítka.
- Nevyhledává tělo poznámky, kontextové claimy, Gmail ani externí data; žádné nové HTTP routy, zapisovače, sdílení, reálný HumanWiki import ani R4 cutover.
- Žádná produkční aktivace; plná Browser E2E nad přesným release SHA zůstává samostatnou podmínkou nasazení.

## Ověření

`node --experimental-loader ./tests/ts-loader.mjs --test tests/target-main-title-search-ui.test.mjs tests/target-staging-title-search-session.test.mjs` (dle existence názvu session testu), následně přesné PR Checks/typecheck/build a cílené UI review. Ověřit ručně nebo browserově 390/1280 px, hidden/offline, rychlé změny input/scope/identity, Back a 401. Bez skutečného zapnutí release flagů.
