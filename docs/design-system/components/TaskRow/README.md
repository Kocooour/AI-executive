# TaskRow — Lumi Design v1.0

Řádek úkolu, včetně jeho plánované rezervace, nebo kanonického úkolu vzniklého z kalendářové události; **žádná druhá dokončovací reprezentace** téže položky. Projektový řádek používá samostatně **kruhovou** stavovou ikonu, stejnou velikost a tučnost názvu a nejvýše jednu věcnou poznámku.

**Co dodává volající:** `title`, autorizovaný stav dokončení, osobní či oprávněný sdílený důvod attention, kompaktní datum/termín a případnou rezervaci, bezpečný sync stav, `onComplete`, `onOpen`.

- **Úkol: vždy čtvercový ovladač**; projekt: vždy kruhový ovladač. Běžná nehotová položka = **prázdná neutrální kontura, bez fajfky**; vyžaduje pozornost = **pouze oranžová/červená kontura, prázdný vnitřek, bez fajfky**; dokončeno = **šedá výplň s fajfkou** a ztlumený název. Neexistuje stav „probíhá“.
- V Mém plánu jsou úkoly v jemně pastelových blocích podle Oblasti **bez viditelného nadpisu/štítku**; čtečka oznámí Oblast a případnou pozornost. Stavový čtverec není barvou Oblasti ani prostoru. **Osobní priorita sdíleného úkolu patří jen aktuálnímu uživateli**, neprozradí stav jiného člena.
- Název úkolu a projektu má stejný token písma, orientačně **17 px / 650**. Bez rámů kolem každého řádku; podle obsahu, nikoli podle odhadu, dotykové cíle nejméně **44 × 44 px**. Případný termín a jasná chyba ukládání zůstanou dostupné. Datum/rezervace patří k jedinému úkolu, ne k další kartě.
- **Projektový seznam** neukazuje počet úkolů, průběh, progress bar ani štítek Oblasti; průběh až v detailu. Projektový kruh dokončení nikdy potichu nedokončí jeho otevřené úkoly.
- VoiceOver: celý typ „Úkol“ / „Projekt“, stav „Nedokončeno / Vyžaduje pozornost: důvod / Dokončeno“, cílová akce dokončení/obnovy a název. Barva nestačí; kontrast kontury nejméně 3:1 na aktuálním pastelovém podkladu.
- Stav a ukázka: [preview.html](preview.html) je **cílové statické zobrazení**, nikoli důkaz implementace nebo platné serverové ACL.
