# BottomNav

Hlavička a spodní navigace na iPhonu (Domů, Doručené, Dnes, Kalendář, Více) a sheet Více (LUMI-UX-009, 012).

**Co dodává volající:** aktivní pohled, aktivní prostor, obsah sheetu Více.

**Pravidla**
- Ikony a barvy jsou totožné se sidebarem (NavItem): domeček `icon-home`, ↓ `icon-inbox`, ★ `icon-today`, kalendář `icon-calendar`, tři tečky (SVG, vycentrované) neutrální; v sheetu Více také → `icon-upcoming`, krabice `icon-projects`, ◎ `icon-areas`, list `icon-notes`, lupa `icon-search`. Ikony 18 px.
- Aktivní položka: pozadí `ws-*-soft` aktivního prostoru a tučný popisek. Aktivní je vždy jen jedna; při otevřeném sheetu Více.
- Prostor: 3px proužek `ws-*` nahoře a dlaždice s názvem v hlavičce (cíl 44 px).
- Nadpis Dnes nese žlutou hvězdu jako v Things.
- Sheet Více: úchyt + ✕, dlaždice 44 px s barevnou ikonou. FAB se při otevřeném sheetu skryje. Respektovat `safe-area-inset-bottom`.
