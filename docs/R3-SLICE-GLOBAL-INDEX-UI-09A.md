# R3 / UI-09a — izolovaný globální čtecí náhled Vše / Osobní / Sdílené

**Stav:** nová staging-only adresa `/target-staging/global-index/preview`. Není součástí běžného Lumi shellu, navigace ani produkčního UI-09. Navazuje na BE-16 / PR #305 a existující serverově autorizovaný R2d.3m.8 kombinovaný GET.

## Zapnutí pouze explicitním staging opt-in

Serverová stránka vyžaduje současně tři výchozím nastavením vypnuté příznaky: `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED=true`, `AI_EXECUTIVE_TARGET_STAGING_GLOBAL_INDEX_CLIENT_PREVIEW_ENABLED=true`. Jinak 404. Žádný flag se tímto PR nenastavuje, URL není v produkční navigaci.

## Produkt a bezpečnost

- `Vše` je serverově autorizované sjednocení osobních a sdílených projektů, úkolů (včetně nepřiřazených a práce jiných oprávněných členů) a **názvů** poznámek; není synonymem `Můj plán`. Jediný globální přepínač má `Vše / Osobní / Sdílené` a neotevírá žádná práva. Ve smíšeném seznamu má každá položka vedle barevného okraje také **viditelné a čtečkou dostupné** označení `Osobní` nebo `Sdílené` (typ oprávněné Oblasti).
- Po přepnutí rozsahu se nejprve zneplatní aktuální generace GET a odstraní všechny dřívější řádky. Po skrytí karty, `offline`, `pagehide` (včetně BFCache) a při unmountu se přeruší čtení a vymaže renderovaný seznam. `visibilitychange`, `focus`, `pageshow` a `online` vyvolají nové serverové ověření; 350ms slučování se týká pouze duplicitních foreground událostí bez mezilehlé invalidace.
- Při `Načíst další položky` se do úspěchu nového actor/session/Area-authorized GET obsah skryje. Reakce starého `AbortSignal`/generace se ignoruje. Všechny chyby a HTTP 401/409 odstraní obsah, žádná chybová větev nevrací staré titulky. Před skrytím seznamu se fokus klávesnice přemístí na **trvale vykreslený, fokusovatelný stavový prvek** (`role=status`); při úspěchu i 401/409 na něm zůstává, aby po odmountování tlačítka nezanikl.
- Data se nepersistují do IndexedDB, localStorage ani cookies; žádný zápis, změna Area, offline fronta, retry, sdílení, produkční cutover nebo migrace. Server zůstává autoritou identity a live ACL.

## Ověření

Základní unitní testy prověřují 404 gate, globální rozsahy a čtecí lifecycle. **Nový cílený Chromium browser test** `e2e/global-index-preview-ui09a.spec.ts` přímo mountuje skutečnou React stránku a pomocí izolovaného syntetického fetch adaptéru, který záměrně ignoruje AbortSignal, ověřuje DOM: změna rozsahu okamžitě skryje staré soukromé titulky; opožděná odpověď staré identity je nesmí obnovit; `visibilitychange(hidden)`, `pagehide`/BFCache a offline smažou původní DOM, návrat jej znovu autorizuje; a 409/401 při pokračování stránkování nesmí zobrazit dřívější položky. Po opravě P2 navíc provádí klávesnicí `Enter` na tlačítku pokračování a kontroluje fokus na trvalém statusu během čekání, po úspěchu a po 401/409. Smíšený výsledek `Vše` ověřuje čitelnými textovými popisy obou druhů Oblastí. `global-index-preview-browser.yml` běží pouze pro dotčené změny v samostatné ephemeral instanci s izolovanými testovacími přihlašovacími údaji a těmito třemi příznaky zapnutými **jen uvnitř CI testu**. Nikdy nejde o skutečnou produkční aktivaci. Bezpečnostní transportní testy BE-16 a serverové cross-identity testy existují zvlášť. Plné browser E2E je až předprodukční release gate na přesném SHA a schváleném cutoveru.
