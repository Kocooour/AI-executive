# Lumi — design systém (návrh)

> **Částečně implementováno.** V runtime jsou napojené generované tokeny, barevné rozlišení prostorů, dlaždice přepínače, ikony a zvýraznění navigace na desktopu i mobilu (navigace v1), jednotný fokus a 44px dotykové cíle a tichý Home: nadpis bez pozdravu, stav jen při problému, AttentionItem a StatusChip (Home v1, body A1, A3, A4, B6; mobilní nabídka Více E3 v [zmeny-ui.md](zmeny-ui.md)); seznamové řádky TaskRow (B4) jsou implementované v pracovních seznamech. Ukázky ostatních komponent (PlanBlock, ProposalCard, 3-panelový detail aj.) jsou nadále **návrhy**, nikoli implementované UI. Podrobný seznam: [zmeny-ui.md](zmeny-ui.md). Logo: `public/icons/lumi-icon-v3-*.png`.

Lumi je osobní AI asistent pro řízení práce. Rozhraní je tiché, ve stylu Things: velký nadpis, čisté řádky, málo slov. Barva znamená buď **akci** (`accent`), **stav** (`danger`, `warning`), nebo **prostor**, ve kterém pracujete (`ws-personal`, `ws-work`, `ws-family`).

## Soubory

- [tokens.json](tokens.json) – jediný zdroj hodnot (barvy pro světlé i tmavé téma, typografie, mezery, rádiusy, stín).
- [tokens.css](tokens.css) – CSS proměnné a třídy typografie vygenerované z `tokens.json` příkazem `node scripts/design-tokens.mjs`. Ručně neupravovat; `pnpm test` (`tests/design-tokens.test.mjs`) selže, když se s `tokens.json` rozejde nebo když ukázka použije neexistující token.
- `components/<Název>/README.md` – pravidla komponenty; `preview.html` – statická ukázka, která načítá `../../tokens.css`, takže se dá otevřít přímo z checkoutu v prohlížeči. Tmavé téma: atribut `data-theme="dark"` na `<html>` nebo systémové nastavení.
- Stejný obsah je publikovaný jako interaktivní design systém v Claude (soukromý artefakt vlastníka); zdrojem pravdy je tento adresář.

## Štítky, metadata a druhý řádek

Jedno pravidlo pro všechny komponenty:

| Prvek | Povoleno | Kde |
|---|---|---|
| Záhlaví sekce | Jen tučný nadpis `card-title` („Pozornost“, „Plán“). Žádné verzálky, tečky ani podtitulek. | Home, Dnes, Kalendář |
| Štítek | Střídmě, jen když sděluje významný stav, například „Návrh“, „Provedeno“, „Skryto“ nebo „Konflikt“. Stav je čitelný i bez barvy; text a pozadí mají kontrast alespoň 4,5 : 1. | ProposalCard, PlanBlock, kalendář |
| Údaj vpravo | Střídmě jeden hlavní údaj vpravo (`meta`); důležitý termín a časová rezervace mohou být srozumitelně v dalším kompaktním řádku téhož úkolu, bez druhé akční položky. | TaskRow, PlanBlock, NavItem |
| Doplňující řádek | U doporučení na Home jen krátký důvod; přístupné Proč? rozbalí lidsky čitelný zdroj a přesný čas vyhodnocení. Jinde jen když je potřebný pro pochopení položky nebo stavu, například typ vstupu či další krok projektu. Na úzkém displeji se text může zalomit. | AttentionItem, Inbox, projekty |
| Kontext a technické údaje | Původ a přesný čas vyhodnocení doporučení jsou v přístupném Proč? běžnou řečí; zastaralost, nejistota a konflikt jsou vidět okamžitě. Oprávněný zdroj lze otevřít. Interní ID, revize, názvy pravidel, diagnostika a technické názvy časových zón nepatří na hlavní obrazovky ani do detailu úkolu, ani do rozbalených částí. Cílový prostor, platnost a dopad návrhu zůstávají před schválením viditelné. Významné stavy nesmí být dostupné jen v nápovědě (`title`). | Home, detail úkolu, ProposalCard |

## Méně slov

- Štítky, údaje v řádku a druhý řádek se řídí tabulkou výše.
- Důvod doporučení má jednu krátkou větu: „Po termínu od 13. 10.“, ne „Termín 13. 10. již uplynul po konci místního dne.“
- Trvalý synchronizační stav se ukazuje, když ovlivňuje práci: „Synchronizováno“ se běžně neukazuje, „Offline · 3 změny čekají“ ano. Při editaci zůstává viditelné ukládání, potvrzení uložení i případná chyba; návrh, schválení a výsledek mají vždy srozumitelný stav.
- Pozdravy, podtitulky typu „Takhle vypadá váš dnešní den.“ a prázdné karty („Žádný úkol právě neběží.“) se nepoužívají.
- Akce u položky se ukáží po najetí nebo fokusu (desktop) a v detailu (mobil). Na klávesnici jsou vždy dosažitelné.
- Česky, vykáním, bez emoji a vykřičníků. Návrh mluví jako návrh („Přesunout na zítra?“), hotová věc jako hotová („Přesunuto · Zpět“).

## Prostor (workspace)

- Každý prostor má barvu a písmeno: Osobní `ws-personal` (indigo, O), Pracovní `ws-work` (P), Rodinný `ws-family` (R). Všechna práce (jen čtení) je neutrální `ws-all`.
- Barva prostoru je vždy jeden z těchto tokenů – nikdy libovolná vlastní barva, protože u ní nelze zaručit kontrast `on-ws` (testy hlídají ≥4.5:1 jen pro tuto sadu). Zda se token přiřazuje pevně podle typu prostoru, nebo ho uživatel vybírá z této sady v Nastavení, je **otevřené rozhodnutí vlastníka**; do té doby platí pevné přiřazení.
- Prostor je vidět vždy třemi způsoby zároveň: dlaždice s písmenem a název nahoře v sidebaru, 3px proužek v barvě prostoru přes horní okraj obsahu a výrazné pozadí aktivní položky navigace `ws-*-soft` s tučným textem. Na iPhonu proužek nahoře a dlaždice v hlavičce.
- Písmeno na dlaždici je `on-ws`. Barva nikdy není jediný nosič – vždy s názvem nebo písmenem.
- Barvu prostoru nepoužívat pro akce ani stavy; tlačítka zůstávají modrý `accent`. Proto je Osobní indigo, ne modrá.

## Barvy

- Paleta ve stylu Things: bílá plocha `app-bg`, světle šedý sidebar `sidebar-bg`, modrý `accent`, jasné barevné ikony `icon-*`. Plovoucí vrstvy `surface-raised` se `shadow-soft`; obsah bez karet a rámečků.
- Text `text`; drobné údaje `muted`; počty v sidebaru `muted-light`.
- `accent` jen pro primární akci, odkaz a fokus. Text na `accent` je `on-accent`.
- Stavy: `danger` (po termínu, chyba), `warning` (blíží se, konflikt), `success` (jen krátké potvrzení). Vždy slovo nebo datum, ne podbarvení celého řádku.
- Návrh od Lumi má přerušovaný okraj `proposal` a štítek „Návrh“; potvrzené položky plný okraj `line`.

## Typografie

- Systémové písmo `sans`. Jeden `page-title` na obrazovku, sekce `card-title`, řádky `row`, název doporučení `item-title`, údaj vpravo a důvod `meta`, štítky a popisky navigace `caption`.
- Váhy 400, 540, 600, 650, 700, 720.

## Rozvržení

- **Desktop:** trvalý přímo rolovatelný sidebar s rozsahem Můj plán / Osobní / Sdílené, Home, Inbox, Today, Upcoming, Projects, Calendar, Notes, Areas, uloženými filtry a všemi oprávněnými projekty v právě zvoleném rozsahu bez brány „Více“. Search, Chat a Quick Capture jsou globální v kompaktní liště. Úkol se může otevřít v pravém panelu; projekt má vlastní stránku.
- **Dnes / úkoly / projekty:** výchozí Dnes ukazuje kompaktní události a jeden seznam úkolů, rezervaci na úkolu; úměrná osa je v Kalendáři nebo po výslovném zapnutí Dnes. Řádky rostou podle obsahu, ne odhadu. Detail úkolu má jeden ovladač dokončení a jedno přístupné rozbalení sekundárních vlastností. Projektový řádek má název, průběh a nejvýše jeden další krok nebo problém; stránka začíná úkoly. Starší statické náhledy těchto obrazovek jsou historické a neukazují aktuální cíl.
- **iPhone:** první je jediné rolovatelné kořenové menu se všemi běžnými cíli a oprávněnými projekty; bez spodní lišty, „Více“ či povinného rozbalení. Today/projekt/úkol/poznámka jsou navazující celé stránky se Zpět, který obnoví předchozí posun a rozepsaný text. Capture, filtr a approval mohou být sheets. Search, Chat a Quick Capture jsou v kompaktní liště. Okraj `space-4`, cíle alespoň 44 × 44 px, podpora omezeného pohybu a klávesnice.
- Rádiusy: řádky bez rámečku v jedné ploše `radius-xl`, pole a tlačítka `radius-md`.

## Ikonografie

- Logo `public/icons/lumi-icon-v3-512.png`; maskovatelná verze `lumi-icon-v3-maskable-512.png` jen pro PWA.
- Ikony navigace ve stylu Things, 16 px (mobil 18 px), stejné v sidebaru i na iPhonu: domeček `icon-home` (SVG), ↓ `icon-inbox` (modrá), ★ plná hvězda `icon-today` (žlutá), → `icon-upcoming` (červená), archivní krabice `icon-projects` (fialová), ◎ `icon-areas` (tyrkysová), list se zahnutým rohem `icon-notes` (oranžová), kalendářový list s kroužky `icon-calendar` (zelená), lupa `icon-search` (neutrální, tah 1.8), starší ikona Více je historická pro navigaci v1.
- Kroužek dokončení ○ má `aria-label` „Dokončit …“ a dotykový cíl 44 px.
