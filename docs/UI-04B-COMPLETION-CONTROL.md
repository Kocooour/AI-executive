# UI-04b — sdílený ovladač dokončení v náhledu Lumi v1

Tato iterace sjednocuje **vizuální stav dokončení** úkolů a projektů. Je součástí opt-in náhledu `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, nikoli aktivací cílového Mého plánu ani nového datového modelu.

- Úkol má prázdný **čtverec**, projekt prázdný **kruh**. Pozornost je pouze oranžová nebo červená kontura, žádná barevná výplň ani fajfka. Hotovo používá tlumenou výplň a fajfku.
- Kontura úkolu odráží termín po splatnosti, blízký termín nebo explicitně vysokou prioritu. **Není odvozena z prostoru či Oblasti.** Projekt používá svůj dosavadní výpočet pozornosti.
- Jedna komponenta `LumiCompletionControl` se používá v Today/ostatních pracovních seznamech, Home, mobilním Projects a kalendářních úkolech bez času. Textové přístupné názvy vždy popisují úkon i stav; klikací plocha je nejméně 44 × 44 px.
- V náhledu jsou úchyty řazení v seznamech úkolů a projektů zobrazené jen po explicitní volbě **Upravit pořadí**. V Home nejsou úchyty. Neznámý odhad se v náhledovém řádku nevypisuje.
- Při souhrnném legacy pohledu `all`, nesynchronizované položce nebo bezpečnostním pozdržení je nový ovladač zakázán. Tato úprava **nepřidává žádné ACL ani schopnost zápisu**; legacy řádky bez náhledu zůstávají beze změny.

## Hranice a další práce

Náhled stále čte legacy Today pro aktivní workspace. Nepředstírá autorizovaný výběr Můj plán a nemění staging/production store, backend, migraci, sdílení, AI ani notifikace. UI-04c naváže seskupením Oblastí a dny Dnes/Zítra; **R3-slice** teprve propojí UI se staging endpoints a bezpečnými pending/konflikt/revokace stavy. PR není nasazení. Browser E2E je povinné až před produkčním releasem.

Ověření: `tests/lumi-completion-state.test.mjs`, běžné relevantní unit testy, typecheck a build přes PR Checks na přesném head.
