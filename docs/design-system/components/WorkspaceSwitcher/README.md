# WorkspaceSwitcher

Ukazuje a přepíná prostor (Osobní, Pracovní, Rodinný, Všechna práce) tak, aby byl poznat na první pohled.

**Co dodává volající:** seznam prostorů `{id, název, barva, písmeno, počet Doručených}`, aktivní prostor, `onSelect`.

**Pravidla**
- Prostor se ukazuje třikrát zároveň: dlaždice s písmenem a název nahoře v sidebaru, 3px proužek v barvě prostoru přes horní okraj okna a pozadí aktivní položky navigace `ws-*-soft`.
- Barvy `ws-personal`, `ws-work`, `ws-family`; písmeno `on-ws`. Všechna práce neutrální `ws-all`, štítek „jen čtení“, bez akcí zápisu.
- Menu: dlaždice, název, počet Doručených, zkratka ⌘1–⌘3. Po přepnutí se nesmí ukázat data předchozího prostoru z cache.
- Kde se zapisuje (dialog zachycení, ProposalCard), je vidět dlaždice cílového prostoru.
- Barva prostoru se nepoužívá pro tlačítka ani stavy.
