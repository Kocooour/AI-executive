# NavItem

Položka levého sidebaru na desktopu, ikony a barvy ve stylu Things.

**Co dodává volající:** pohled, ikona, popisek, počet, aktivní stav a aktivní prostor.

**Pravidla**
- Pořadí: Domů, Doručené, Dnes, Nadcházející, Projekty, Oblasti, Poznámky, Kalendář, Hledání. Ostatní pohledy v „Další pohledy“.
- Ikony 16 px v rámečku 18 px: domeček (SVG, tah 1.6) `icon-home`, ↓ `icon-inbox`, ★ plná hvězda `icon-today`, → `icon-upcoming`, archivní krabice `icon-projects`, ◎ `icon-areas`, list se zahnutým rohem `icon-notes`, kalendářový list s kroužky a dny (SVG) `icon-calendar`, lupa (SVG, tah 1.8) `icon-search`. Stejné ikony a barvy používá BottomNav.
- Ikona Poznámek je list papíru – tvarem i barvou (oranžová) se liší od kalendářového listu (zelená).
- Barvu přiřazovat třídou pohledu, ne `nth-child`.
- Aktivní položka: výrazné pozadí `ws-*-soft` aktivního prostoru, text `selected-text` tučně (700), počet tmavý. Ikona si ponechává barvu.
- Text položek `text` (ne `muted`), 14 px – jako v Things.
