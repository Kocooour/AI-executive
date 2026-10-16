# Lumi — design systém (návrh)

> **Návrh, zatím neimplementováno.** Paleta ve stylu Things, barvy prostorů, ikony navigace a porovnání cílových obrazovek z [UX-UI.md](../UX-UI.md) se stavem aplikace k `main@d7d8cca` – viz [zmeny-ui.md](zmeny-ui.md). Logo: `public/icons/lumi-icon-v3-*.png`.

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
| Štítek | Jen dva stavové štítky „Návrh“ a „Provedeno“, malými písmeny se základní velkou počáteční (`caption`), výplň `accent-soft` / `success-soft`. Jiné štítky se nepoužívají. | ProposalCard, PlanBlock |
| Údaj v řádku | Nejvýše jeden, vpravo, styl `meta`: datum (`danger` po termínu), odhad, nebo počet. | TaskRow, PlanBlock, NavItem |
| Druhý řádek | Jen u doporučení na Home (AttentionItem): krátký důvod stylem `meta`. Jinde žádný. | AttentionItem |
| Metadata (zdroj, workspace, čas vyhodnocení, revize) | Nikdy v seznamu. V detailu položky a v nápovědě nadpisu sekce. Výjimka: hlavička ProposalCard ukazuje cílový prostor a platnost, protože bez nich nejde schválit. | Detail, ProposalCard |

Lumi je osobní AI asistent pro řízení práce. Rozhraní je tiché, ve stylu Things: velký nadpis, čisté řádky, málo slov. Barva znamená buď **akci** (`accent`), **stav** (`danger`, `warning`), nebo **prostor**, ve kterém pracujete (`ws-personal`, `ws-work`, `ws-family`).

## Méně slov

- Štítky, údaje v řádku a druhý řádek se řídí tabulkou výše.
- Důvod doporučení má jednu krátkou větu: „Po termínu od 13. 10.“, ne „Termín 13. 10. již uplynul po konci místního dne.“
- Stav se ukazuje jen tehdy, když je problém. „Synchronizováno“ se neukazuje, „Offline · 3 změny čekají“ ano.
- Pozdravy, podtitulky typu „Takhle vypadá váš dnešní den.“ a prázdné karty („Žádný úkol právě neběží.“) se nepoužívají.
- Akce u položky se ukáží po najetí nebo fokusu (desktop) a v detailu (mobil). Na klávesnici jsou vždy dosažitelné.
- Česky, vykáním, bez emoji a vykřičníků. Návrh mluví jako návrh („Přesunout na zítra?“), hotová věc jako hotová („Přesunuto · Zpět“).

## Prostor (workspace)

- Každý prostor má barvu a písmeno: Osobní `ws-personal` (O), Pracovní `ws-work` (P), Rodinný `ws-family` (R). Všechna práce (jen čtení) je neutrální `ws-all`.
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

- **Desktop:** sidebar 226 px s prostorem nahoře a navigací Home, Inbox, Today, Upcoming, Projects, Areas, Notes, Calendar, Search. Obsah max. ~720 px. Inbox, Today, Projects, Notes a Search mají detail jako pravý panel vedle seznamu.
- **iPhone:** spodní navigace Domů, Doručené, Dnes, Kalendář, Více; Quick Capture jedním klepnutím. Detail, návrh a chat jako sheet. Okraj `space-4`, cíle 44 px.
- Rádiusy: řádky bez rámečku v jedné ploše `radius-xl`, pole a tlačítka `radius-md`.

## Ikonografie

- Logo `public/icons/lumi-icon-v3-512.png`; maskovatelná verze `lumi-icon-v3-maskable-512.png` jen pro PWA.
- Ikony navigace ve stylu Things, 16 px (mobil 18 px), stejné v sidebaru i na iPhonu: domeček `icon-home` (SVG), ↓ `icon-inbox` (modrá), ★ plná hvězda `icon-today` (žlutá), → `icon-upcoming` (červená), archivní krabice `icon-projects` (fialová), ◎ `icon-areas` (tyrkysová), list se zahnutým rohem `icon-notes` (oranžová), kalendářový list s kroužky `icon-calendar` (zelená), lupa `icon-search` (neutrální, tah 1.8), Více jako tři SVG tečky.
- Kroužek dokončení ○ má `aria-label` „Dokončit …“ a dotykový cíl 44 px.
