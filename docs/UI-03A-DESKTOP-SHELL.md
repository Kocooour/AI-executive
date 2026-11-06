# UI-03a — desktopový shell Lumi v1 (první řez)

## Východisko a rozsah

První samostatná, **výchozím nastavením vypnutá** část UI-03 po sloučení UI-04c (#259) a UI-04d (#263). Aktivuje se jen při `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` a na desktopu (šířka od 701 px). Neaktivuje cílový model Area/ACL, přepínač globálního Vše ani produkční vzhled. Pokračování UI-03 bude řešit definitivní sjednocení inspektorů a schválený desktop layout. Toto PR neslibuje dokončení celé UI-03 ani první vertikální řez R3-slice.

## Změny

- **Desktop Quick Capture:** jedno fialové plovoucí tlačítko s minimálně 58×58 px a přístupným názvem. Kliknutí používá existující `openCapture` se soukromým výchozím cílem, kontrolou Oblasti a potvrzením sdílení. Žádná nová cesta zápisu.
- **Zkratka ⌘⇧. / Ctrl⇧.:** fyzické tlačítko tečky (`KeyboardEvent.code=Period`), takže funguje i na českém rozložení. Funguje jen při otevřeném náhledu, v desktopové šířce; nezasahuje do textového pole, opakovaného stisku, IME ani již obsloužené události. Při otevřeném skutečně modálním dialogu či Lumi Chatu se nespustí; běžný nemodální desktopový inspektor zkratku neblokuje (pokud fokus není ve vstupním poli). Listener se odregistruje.
- **Volné místo kolem FAB:** čitelný pravý pruh 112 px pro klikací oblasti, dolní odsazení 120 px pro poslední řádek, fokusové odsazení 122 px. FAB se skrývá před inspektorem nebo dialogem. Při otevřeném **nemodálním** inspektoru na 701–1199 px i na širokém desktopu zůstává Quick Capture přístupné z **pevného spodního tlačítka sidebaru** a ze zkratky, aniž se překryjí ovladače inspektoru. Modální dialogy nadále blokují otevření přes zkratku; mobilní FAB a spodní menu nejsou změněny.
- **Desktop sidebar:** ve v1 nejsou vedlejší cíle skryté za `More views` — jsou přímo **před projekty** ve svisle rolovatelném seznamu, takže ani 25+ projektů nezakryje přístup k Oblastem, Poznámkám a filtrům. Footer nemá duplicitní `New`, dokud je inspektor zavřený; když se otevře, zobrazí dostupné náhradní tlačítko. Nastavení zůstává přímé. Aktivní projekty v jednom právě zvoleném legacy prostoru už nejsou omezené na prvních sedm, ale stále jsou filtrovány stávajícím workspace ID a stavem. V legacy agregátu `all` se z bezpečnostních důvodů nezobrazuje odvozený směsný seznam — autorizovaná agregace je úloha UI-09/R3, nikoli této iterace.
- **Hlavička:** Hledání a Lumi Chat zůstávají na desktopu přímo dostupné. Výběr motivu je ve v1 jen v Nastavení a mobilní hlavička se přeuspořádá bez prázdného sloupce; systémový motiv zůstává výchozí.

## Ověření

`tests/desktop-shell-ui03a.test.mjs` pokrývá zkratku Mac/Windows/CZ, textová pole a dialogy, preview-only izolaci, úplný lokální projektový seznam, pořadí přímé navigace před 26–30 projekty, zachování sedmipoložkového legacy omezení, nezměněný legacy agregát, dostupnost Quick Capture na obou desktopových šířkách s otevřeným inspektorem, blokaci skutečných modalit, funkční nastavení motivu a statické pravidlo odstupu od FAB.

Před sloučením: `PR Checks` na přesném HEAD, typecheck, cílené unit testy a produkční build, review. **Skutečná vizuální kontrola v prohlížeči (Mac, 701–1600 px, klávesnice/fokus)** a kompletní Browser E2E se provádějí před produkčním releasem. Žádný reset ani nasazení, jen nové PR.
