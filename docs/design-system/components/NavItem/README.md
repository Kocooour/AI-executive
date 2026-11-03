# NavItem

Položka levého sidebaru na desktopu, ikony a barvy ve stylu Things.

**Co dodává volající:** pohled, ikona, popisek, počet, aktivní stav a aktivní prostor.

**Pravidla**
- Pořadí přímých cílů: Domů, Doručené, Dnes, Nadcházející, Projekty, Kalendář, Poznámky, Oblasti, uložené filtry a všechny oprávněné projekty v právě zvoleném rozsahu ve viditelných rolovatelných skupinách. Hledání je globální v kompaktní liště; technické Agents mohou zůstat v Nastavení. Žádná brána „Více“ ani povinné „Další pohledy“.
- Ikony 16 px v rámečku 18 px: domeček (SVG, tah 1.6) `icon-home`, ↓ `icon-inbox`, ★ plná hvězda `icon-today`, → `icon-upcoming`, archivní krabice `icon-projects`, ◎ `icon-areas`, list se zahnutým rohem `icon-notes`, kalendářový list s kroužky a dny (SVG) `icon-calendar`, lupa (SVG, tah 1.8) `icon-search`. Stejné ikony a barvy používá mobilní kořenové menu; BottomNav je historická navigace v1.
- Ikona Poznámek je list papíru – tvarem i barvou (oranžová) se liší od kalendářového listu (zelená).
- Barvu přiřazovat třídou pohledu, ne `nth-child`.
- Aktivní položka: výrazné pozadí `ws-*-soft` aktivního prostoru, text `selected-text` tučně (700), počet tmavý. Ikona si ponechává barvu.
- Text položek `text` (ne `muted`), 14 px – jako v Things.

Cílový desktopový sidebar je přímo rolovatelný a obsahuje všechny oprávněné projekty v právě zvoleném rozsahu i běžné cíle bez brány „Více“. Na telefonu se stejné přístupné položky zobrazují v jednom rolovatelném kořenovém menu; otevřený pohled má Zpět na původní pozici.
