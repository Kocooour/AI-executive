# UI-03a — desktopový shell Lumi v1 (první řez)

## Východisko a rozsah

První samostatná, **výchozím nastavením vypnutá** část UI-03 po sloučení UI-04c (#259) a UI-04d (#263). Aktivuje se jen při `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` a na desktopu (šířka od 701 px). Neaktivuje cílový model Area/ACL, přepínač globálního Vše ani produkční vzhled. Pokračování UI-03 bude řešit definitivní sjednocení inspektorů a schválený desktop layout. Toto PR neslibuje dokončení celé UI-03 ani první vertikální řez R3-slice.

## Změny

- **Desktop Quick Capture:** jedno fialové plovoucí tlačítko s minimálně 58×58 px a přístupným názvem. Kliknutí používá existující `openCapture` se soukromým výchozím cílem, kontrolou Oblasti a potvrzením sdílení. Žádná nová cesta zápisu.
- **Zkratka ⌘⇧. / Ctrl⇧.:** fyzické tlačítko tečky (`KeyboardEvent.code=Period`), takže funguje i na českém rozložení. Funguje jen při otevřeném náhledu, v desktopové šířce; nezasahuje do textového pole, opakovaného stisku, IME ani již obsloužené události. Při otevřené modalitě, detailu či Lumi Chatu se nespustí; listener se odregistruje.
- **Volné místo kolem FAB:** čitelný pravý pruh 112 px pro klikací oblasti, dolní odsazení 120 px pro poslední řádek, fokusové odsazení 122 px. FAB se skrývá před inspektorem nebo dialogem. Mobilní FAB a spodní menu nejsou změněny.
- **Desktop sidebar:** ve v1 nejsou vedlejší cíle skryté za `More views` — jsou přímo ve svisle rolovatelném seznamu pod projekty, bez duplicitního `New` ve footeru; Nastavení zůstává přímé. Aktivní projekty v jednom právě zvoleném legacy prostoru už nejsou omezené na prvních sedm, ale stále jsou filtrovány stávajícím workspace ID a stavem. V legacy agregátu `all` se z bezpečnostních důvodů nezobrazuje odvozený směsný seznam — autorizovaná agregace je úloha UI-09/R3, nikoli této iterace.
- **Hlavička:** Hledání a Lumi Chat zůstávají na desktopu přímo dostupné. Výběr motivu je ve v1 jen v Nastavení a mobilní hlavička se přeuspořádá bez prázdného sloupce; systémový motiv zůstává výchozí.

## Ověření

`tests/desktop-shell-ui03a.test.mjs` pokrývá zkratku Mac/Windows/CZ, textová pole a dialogy, preview-only izolaci, úplný lokální projektový seznam, zachování sedmipoložkového legacy omezení, nezměněný legacy agregát, funkční nastavení motivu a statické pravidlo odstupu od FAB.

Před sloučením: `PR Checks` na přesném HEAD, typecheck, cílené unit testy a produkční build, review. **Skutečná vizuální kontrola v prohlížeči (Mac, 701–1600 px, klávesnice/fokus)** a kompletní Browser E2E se provádějí před produkčním releasem. Žádný reset ani nasazení, jen nové PR.
