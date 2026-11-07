# UI-06e — sjednocený kruhový symbol projektu v navigaci v1

## Rozsah
Schválené vizuální pravidlo Lumi: **úkol = čtverec, projekt = kolečko**. Projekty se již v samotném seznamu zobrazují pomocí kruhového ovládacího prvku; navigace však dosud používala starou ikonu archivu.

Pouze s explicitním vývojovým flagem `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`:
- Mobilní záložka **Projekty** a desktopová položka **Projekty** používají stejné obrysové kolečko.
- Jednotlivé projekty v levém desktopovém sidebaru používají stejné kolečko místo staré ikony archivu.
- Sidebar zobrazuje jen aktivní projekty; dokončené jsou nadále spravovány v přehledu projektů. Tento PR nemění jejich zobrazení ani stav.
- Kolečko v navigaci je **neinteraktivní, skryté pro čtečky a není checkbox**. Kliknutí na celý projekt v sidebaru dál otevírá projekt; dokončení projektu se mění jen existujícím skutečným ovládacím prvkem v přehledu projektů.
- Produkční default-off UI si zachovává svou původní archivní ikonu v obou navigacích, bez přepisu původního `ProjectIcon` kontraktu.

## Testovací brány
- `tests/project-circle-navigation-ui06e.test.mjs` — obrysová vs původní varianta ikony, flag, ochrana navigačního významu, styly dokončení.
- `e2e/mobile-navigation-v1.spec.ts` — cílený Chromium test vykreslení mobilní záložky a desktopového sidebaru; ověření že kliknutí na konkrétní projekt pouze naviguje.
- Standardní CI: typecheck, Node unit testy, produkční build; cílená flag-enabled Chromium workflow. Kompletní Browser E2E a WebKit patří do předprodukční validační brány.

Bez změny URL, oprávnění, serveru, zapisovaných dat, datového modelu ani produkčního rolloutu.
