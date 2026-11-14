# UI-01e — Bezpečný návrat fokusu z inspektoru úkolu či poznámky

## Problém

Dosavadní `DetailPanel` si držel jediný DOM element `returnFocusRef`. Když uživatel otevřel úkol A klávesnicí a poté přepnul na B jinou cestou, nebyla původní reference zahozena. Po zavření B se fokus mohl nesprávně vrátit na tlačítko A. Reference také zůstávala uložená po úspěšném návratu a výběr nepodmínila ID konkrétní entity.

## UI-01e

- Při každé nové inspektované entitě nebo změně aktivního pohledu/prostoru se stará reference bezpodmínečně vymaže. Změna prostoru/pohledu **zakáže nové zachycení v daném přechodu**, i když je předchozí `.taskRowOpen` stále aktivní a ID výběru se nezmění. Nový fokusový původ vznikne jen při novém otevření ve stejném kontextu a jen tehdy, když je aktivní tlačítko `.taskRowOpen` **skutečně uvnitř řádku `[data-drop-entity]` pro právě vybranou entitu**.
- Původ nese ID entity, prostor a pohled, nikoliv její text či obecný DOM selektor.
- Při zavření se reference spotřebuje **právě jednou**, i když je prvek odstraněn; návrat je povolen jen při stále připojeném, vykresleném a identickém řádku v původním prostoru/pohledu.
- Přímé URL, otevření bez identifikovatelného řádku, přepnutí jiného úkolu nebo prostoru a odstraněný řádek nevyvolávají chybný fokus. Klávesnicové otevření ze správného řádku a zavření/Zpět zachovávají dosavadní vhodný návrat.
- Nemění se per-entry navigační historie projektu z UI-01d, žádné URL, synchronizace, data ani autorizace. Pomocná funkce rozhoduje pouze o lokální prezentaci fokusu. Platí pro existující inspektor, žádné rozšíření R3/ACL.

## Kontrola

Cílené Node unit testy nyní **vykonávají skutečný životní cyklus** `advanceInspectorReturnFocus` s DOM doubles: A→zavření→B→zavření, shodu ID, změnu pohledu/prostoru, odstraněný/skrytý/převázaný prvek a jediný platný návrat. Nejde pouze o regex kontroly zdrojového kódu. `e2e/inspector-return-focus-ui01e.spec.ts` navíc ověřuje skutečné React události a fokus v Chromium (včetně přímého přepnutí A→B bez zavření A, výběru B kliknutím do nefokusovatelného řádku a přímého odkazu); spouští se v předprodukční browserové bráně. PR checks nadále zahrnují typecheck, cílené unit testy a build; manuální VoiceOver zůstává součástí předprodukční přístupnostní kontroly.

## Release 0 / C10 — Close vs. historie (issue #416)

- **Close** (tlačítko, mobilní zavření i podporovaný Escape) vždy zavře aktuální legacy inspektor; neprovádí `history.back()`. URL se změní na bezpečný pohled/seznam nebo nadřazený projekt bez `taskId`/`noteId`.
- **Back/Forward** nadále prochází záznamy: otevření A → B vytváří dva samostatné kroky; Back zobrazí A, Forward znovu B. Přímý odkaz a reload otevírají oprávněný záznam jako dosud.
- **Close používá `replaceState`, nikoli `pushState`**: právě zavřený B se nevrátí při dalším Back. Starší záznam A stále existuje v historii a Back na něj může přejít; neodstraňujeme předchozí uživatelskou navigaci.
- Fokus se po zavření vrací pouze na platný řádek *posledního* otevřeného záznamu. Při přepnutí A → B kliknutím na nefokusovatelnou plochu se dohledá viditelné tlačítko B, ale pouze při skutečném přepnutí existujícího inspektoru ve stejném pohledu/prostoru. Pokud řádek již neexistuje, nepřebírá se fokus A. Přímý odkaz nemá předchozí inspektor, takže jeho řádek tímto způsobem nepřebírá.
- Při zavření inspektoru otevřeného z projektové stránky se zachová její původní návratový krok a případný `lumiFocusEntry`. Historie `projekt → úkol A → úkol B → Close` obsahuje stále předchozí záznam A, ale projektové `Zpět` přeskočí vložené inspektorové kroky a vrátí se na skutečný původ projektu (například Home), nikoliv na jeho duplicitní URL. Přímo otevřený projekt bez známého původu se bezpečně zavře do seznamu projektů.
- Parametr čtecího rozsahu `scope=personal|shared` zůstává zachovaný při otevření úkolu, zavření inspektoru i při přechodu na nadřazený projekt či bezpečný seznam. Nahrazuje se pouze část URL identifikující konkrétní záznam; `scope` není oprávnění.
- Regresní testy jsou v `e2e/detail-inspector-b2.spec.ts`, `e2e/inspector-return-focus-ui01e.spec.ts` a `e2e/project-page.spec.ts`. Focused CI spouští kompletní inspektorové sady samostatně a poté všech pět úplných sad (`record-links-ui01`, `navigation-unavailable-ui01c`, `project-page`, `detail-inspector-b2`, `inspector-return-focus-ui01e`) v jednom sériovém běhu `--workers=1` bez preview flagů. Pořadí zajišťují dočasné očíslované kopie spec souborů; `playwright --list` pouze ověřuje očekávané pořadí a počet testů (neslouží k jejich výběru). Target detail panel zůstává nedotčen.
