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

Cílené Node unit testy nyní **vykonávají skutečný životní cyklus** `advanceInspectorReturnFocus` s DOM doubles: A→zavření→B→zavření, shodu ID, změnu pohledu/prostoru, odstraněný/skrytý/převázaný prvek a jediný platný návrat. Nejde pouze o regex kontroly zdrojového kódu. `e2e/inspector-return-focus-ui01e.spec.ts` navíc ověřuje skutečné React události a fokus v Chromium (včetně výběru B kliknutím do nefokusovatelného řádku a přímého odkazu); spouští se v předprodukční browserové bráně. PR checks nadále zahrnují typecheck, cílené unit testy a build; manuální VoiceOver zůstává součástí předprodukční přístupnostní kontroly.
