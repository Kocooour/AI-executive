# UI-04d — Klidnější Kalendář v náhledu Lumi v1

## Rozsah a bezpečnost

Dílčí změna rozhraní nad existujícím legacy kalendářovým zdrojem. Je dostupná **jen** při `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1`, bez produkčního cutoveru, nového oprávnění, migrace, změny API či synchronizačního modelu. UI-04c (#259) je již v `main`. Paralelní cílové staging rozhraní R3-slice UI-02 (#262) mění jiné soubory a zůstává samostatné.

## Chování

- V režimu Lumi v1 kalendář **neukazuje technický název časové zóny**, seznam diagnostických revizí zdrojů ani duplicitní statusy čerstvosti. Stav má jednu prioritu: *odpojený zdroj* → *vybraný jiný den se samostatným upozorněním na neúplnost* → *čerstvá dnešní kapacita* → *neaktuální data, bez tvrzení o volných hodinách*. Původní technické informace zůstávají interně dostupné pro výpočty událostí, kapacity a synchronizace a při vypnutém náhledu se stará obrazovka nemění.
- U vybraného jiného dne zůstává jediná pravdivá zpráva o nejisté úplnosti kalendáře, existující přechodové stavy Načítám/Chyba/Mimo dostupný rozsah, explicitní Retry a jedna časová osa. Kalendářové filtry, události přes půlnoc, celodenní data a časová zóna pro výpočty se nemění.
- Datový pás má **zkratku dne nad číslem data**, vybraný den fialový, minulé nevybrané dny šedé, `aria-pressed` a plné datum pro čtečku. Vybírá vždy **jeden den**, bez přepínače 1/3/7. Zrušené duplicitní šipky ‹ › nahrazuje posun pásu a jediný přístupný návrat **Dnes**; výběr okrajové bublinky rozšíří zobrazené datumy dál.
- Plovoucí Quick Capture se neschovává. Mobilní kalendář s náhledem v1 rezervuje spodní odsazení a `scroll-margin` pro fokus, aby poslední řádky a akce šly odrolovat mimo překryv tlačítkem a spodním menu. Beze změny pozice či chování v legacy UI.
- Ruční obnovení kalendáře oznámí případné selhání samostatnou dostupnou zprávou. Chyba je svázaná s právě vybraným prostorem, návštěvou obrazovky a generací požadavku. Přepnutí prostoru nebo obrazovky a nové úspěšné načtení kalendáře (včetně obnovení na pozadí či v Nastavení) starou chybu skryjí; pozdní zamítnutí staršího souběžného požadavku nesmí přepsat novější výsledek. Staré texty typu „připojeno“ se v náhledu nekombinují s odpojeným nebo zastaralým stavem.

## Ověření

`tests/calendar-ui04d.test.mjs` ověřuje prioritizaci stavů i nejednoznačné kombinace čerstvosti/zdrojů, skrytí technického stavu výhradně v náhledu, jeden ovladač Dnes, zachování přístupného posuvného pásu, CSS clearance a oddělení legacy větve. Stávající `tests/mobile-calendar-day.test.mjs` ověřují přeshraniční intervaly, all-day a DST.

Před sloučením: povinné `PR Checks` na přesném HEAD (typecheck, vybrané unit/security testy, produkční build), code review po každém diff-changing commitu. Kompletní Browser E2E až na přesném SHA před produkčním nasazením. Nikoli samostatný souhlas s releasem.
