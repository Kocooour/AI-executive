# UI-01e — Bezpečný návrat fokusu z inspektoru úkolu či poznámky

## Problém

Dosavadní `DetailPanel` si držel jediný DOM element `returnFocusRef`. Když uživatel otevřel úkol A klávesnicí a poté přepnul na B jinou cestou, nebyla původní reference zahozena. Po zavření B se fokus mohl nesprávně vrátit na tlačítko A. Reference také zůstávala uložená po úspěšném návratu a výběr nepodmínila ID konkrétní entity.

## UI-01e

- Při každé nové inspektované entitě nebo změně aktivního pohledu/prostoru se stará reference bezpodmínečně vymaže. Nový fokusový původ vznikne jen tehdy, když je aktivní tlačítko `.taskRowOpen` **skutečně uvnitř řádku `[data-drop-entity]` pro právě vybranou entitu**.
- Původ nese ID entity, prostor a pohled, nikoliv její text či obecný DOM selektor.
- Při zavření se reference spotřebuje **právě jednou**, i když je prvek odstraněn; návrat je povolen jen při stále připojeném, vykresleném a identickém řádku v původním prostoru/pohledu.
- Přímé URL, otevření bez identifikovatelného řádku, přepnutí jiného úkolu nebo prostoru a odstraněný řádek nevyvolávají chybný fokus. Klávesnicové otevření ze správného řádku a zavření/Zpět zachovávají dosavadní vhodný návrat.
- Nemění se per-entry navigační historie projektu z UI-01d, žádné URL, synchronizace, data ani autorizace. Pomocná funkce rozhoduje pouze o lokální prezentaci fokusu. Platí pro existující inspektor, žádné rozšíření R3/ACL.

## Kontrola

Cílené Node unit testy zahrnují A→B→zavření, shodu ID, původní pohled/prostor, odstraněný/skrytý prvek a platný klávesnicový návrat. PR checks: typecheck, cílené testy a build. Reálné browserové testy s klávesnicí/VoiceOver patří do předprodukční release brány.
