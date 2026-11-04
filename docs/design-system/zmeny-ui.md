# Změny UI — historický plán před Lumi Design v1.0

> **Historický audit a návrh 10/2026, nikoli současný cílový kontrakt.** Staré pracovní/rodinné prostory, přepínače, mobilní menu a modrá paleta v tomto dokumentu jsou nahrazeny [Lumi Design v1.0](README.md), [UX/UI](../UX-UI.md) a [produktovým rozhodnutím](../decisions/2026-10-23-prostory-oblasti-muj-plan.md#dodatek-2026-11-04--globální-rozsah-vše-versus-osobní-můj-plán). Záznam pozorování a tehdejšího stavu implementace zůstává kvůli auditovatelnosti; nepřebírat jeho staré akceptační požadavky do nových UI PR.


> **Historický záznam navigace v1 a starších náhledů Home.** Pro cílové Home platí přístupné Proč? a pro cílovou navigaci jedno rolovatelné menu podle [UX/UI](../UX-UI.md); dřívější věty o druhém řádku s časem u každé karty a sheetu Více už nejsou normativní.

Porovnání cílových obrazovek LUMI-UX-001 až 015 (`docs/UX-UI.md`) se současnou aplikací (`main@d7d8cca`). Aplikace byla spuštěna lokálně s ukázkovými daty a prošla na desktopu (1440 × 900) i iPhonu (390 × 844). Každý návrh níže odkazuje na obrazovku ze specifikace a na komponentu tohoto systému, která cílový stav ukazuje.

**Celkově:** základ odpovídá – sidebar má správné pořadí, Home začíná pozorností a ukazuje zdroj i čas vyhodnocení, mobil má spodní navigaci a Quick Capture. Největší mezery jsou ve třech věcech: **(1)** chybí jednotná obrazovka návrhu a schválení, **(2)** detail se otevírá jako modální překryv místo 3-panelového inspektoru, **(3)** návrh a potvrzený stav nejsou vizuálně odlišené.

## Směr: méně slov, jasný prostor

Dvě zásady od vlastníka produktu (15. 10.) platí pro všechny návrhy níže.

**Tiché UI ve stylu Things.** Dnes Home na jedno doporučení použije 9 řádků textu: pozdrav, podtitulek, tři čipy, hlavičku sekce, zdroj, název, důvod, metadata a dvě rozbalovací volby. Cíl je 2 řádky: název a krátký důvod, vpravo „Otevřít“. Konkrétně:

| Dnes | Navrženo |
|---|---|
| „Dobré odpoledne“ + „Takhle vypadá váš dnešní den.“ | „Domů“ nebo jen datum; bez podtitulku |
| Čipy „1 v Doručených k roztřídění · Data: Synchronizováno · Dnešní kapacita: Kalendář není připojen“ | Nic. Počet Doručených je v sidebaru, problém se synchronizací jako jediný řádek jen když nastane |
| „• VYŽADUJE POZORNOST“ + „Zdroj: serverová data · vyhodnoceno 15. 10. 13:31“ | Tučné „Pozornost“; zdroj a čas vyhodnocení u každé položky (viz níže) |
| „Termín 13. 10. již uplynul po konci místního dne.“ + „Úkol · Osobní · zaznamenaný termín · vyhodnoceno …“ | „Po termínu od 13. 10.“ |
| „Další možnosti a zdroje“, „Pokrytí a čerstvost“ | Odložit/Skrýt po najetí nebo fokusu; ID zdrojů a revize v detailu |
| Podtitul řádku „Doručené“, „Dnes“, „Projekty“ | Žádný; vpravo datum nebo odhad, jen když existuje |
| „Lumi · právě teď – Žádný úkol právě neběží.“ | Nic, dokud úkol neběží |
| „Bez vhodného bloku“ + „Po termínu · 60 min · Výchozí odhad“ + „Proč právě teď“ + 3 tlačítka u každé položky | Řádek s „60 min“ vpravo; Jiný čas/Zítra/Neplánovat po najetí |

Specifikace u Home požaduje u každé karty „důvod, zdroj, čas vyhodnocení“. Návrh to dodržuje: všechny tři údaje jsou ve druhém řádku každé položky, krátce a bez rozbalování (zdroj jako typ důkazu, např. „termín úkolu“, „projekt bez další akce“; čas jen hodina, u starších dat datum). Je to vidět na dotyku i z klávesnice a nevyžaduje to změnu `docs/UX-UI.md`. Do detailu se přesouvají jen ID zdrojů, revize a časová zóna.

**Prostor na první pohled.** Dnes je prostor jen 13px text „Osobní ⌄“ nad navigací a na mobilu 11px nad vyhledáváním. Snadno se splete, kam se právě zapisuje. Návrh – sekce **W** a komponenta **WorkspaceSwitcher**.

## Přehled podle obrazovek

| ID | Obrazovka | Shoda | Hlavní mezera | Návrh |
|---|---|---|---|---|
| UX-001 | Home / Denní brief | Částečná | Příliš mnoho textu (pozdrav, čipy, metadata); Snooze/Skrýt schované; plán vnořený v kartě Dnes | A1–A4 |
| UX-002 | Lumi Chat | Částečná | Panel funguje, ale návrh změny je jen seznam „popisek: hodnota“ | C1 |
| UX-003 | Návrh → schválení → akce | Chybí | Žádná sdílená obrazovka; před/po, workspace, dopady, expirace se nezobrazují | C1 (P0) |
| UX-004 | Desktop Calendar | Slabá | Bez časové osy; „Kalendář není připojen“ dvakrát; pod kalendářem plný seznam všech úkolů | D1 |
| UX-005 | Detail projektu | Slabá | Chybí cíl, stav, další akce, riziko, poslední aktivita; termín a Oblast jako nestylované inline pole | B2 |
| UX-006 | Inbox | Částečná | Jen seznam úkolů; zachycení umí jen úkol; chybí triage akce a 3-panel | B1, B3 |
| UX-007 | Notes | Slabá | Seznam bez data, původu a vazeb; podtitul řádku je jen „Poznámky“ | B4 |
| UX-008 | Global search | Slabá | Prázdná obrazovka bez pole, filtrů a nápovědy, dokud se nepíše nahoře | B5 |
| UX-009 | iPhone Home | Částečná | Tři stavové čipy a karta pozornosti zaberou celý první výřez; prostor téměř neviditelný | E1, W2 |
| UX-010 | Mobile capture | Částečná | Jen text úkolu; typ vstupu (myšlenka, odkaz, vložený text) nelze zvolit | B3 |
| UX-011 | Mobile approval | Chybí | Viz UX-003; na mobilu má být spodní sheet | C1 |
| UX-012 | Mobile Today | Částečná | Prázdná karta „Žádný úkol právě neběží“ a plán dne odsouvají samotné úkoly pod ohyb | E2 |
| UX-013 | Mobile Calendar | Slabá | Stejné jako UX-004 | D1 |
| UX-014/015 | Notifikace, hlas | P2 | Mimo rozsah tohoto kola | – |

## W. Prostor (workspace)

**W1 – Barva a písmeno pro každý prostor.** Osobní `ws-personal` (indigo, odlišné od modrého `accent`; O), Pracovní `ws-work` (oranžová, P), Rodinný `ws-family` (zelená, R); Všechna práce neutrální `ws-all` s popiskem „jen čtení“ (text `caption`, ne štítek). Barva je vždy jeden z tokenů `ws-*` (se `ws-*-soft` a `on-ws`), nikdy libovolná barva – jen tak je zaručený kontrast písmene na dlaždici. **Otevřené rozhodnutí vlastníka:** přiřazení pevně podle typu prostoru (výchozí, platí do rozhodnutí), nebo výběr z téže pevné sady v Nastavení uložený jako odkaz na token v entitě `workspace`.

**W2 – Tři signály zároveň.** (a) Nahoře v sidebaru dlaždice 22 px s písmenem a název prostoru tučně místo „Osobní ⌄“; (b) 3px proužek v barvě prostoru přes horní okraj obsahu; (c) aktivní položka navigace má pozadí `ws-*-soft` místo šedé `selected`. Na iPhonu proužek pod stavovým řádkem a dlaždice s názvem vlevo v hlavičce (cíl 44 px). Ukázka: **WorkspaceSwitcher**, **NavItem**, **BottomNav**.

**W3 – Přepínání.** Menu prostorů ukazuje dlaždice s počty Doručených; zkratky ⌘1–⌘3. Dialog zachycení a ProposalCard ukazují dlaždici cílového prostoru, aby bylo jasné, kam se zapisuje.

## A. Home / Denní brief

**A1 – Doporučení na dva řádky.** Název + druhý řádek *důvod · zdroj · čas vyhodnocení* („Po termínu od 13. 10. · termín úkolu · 13:31“). Vpravo „Otevřít“; Odložit a Skrýt po najetí nebo fokusu, na mobilu v detailu. ID zdrojů, revize a časová zóna jen v detailu. Ukázka: **AttentionItem**.

**A2 – Plán dne jako samostatná sekce.** Plán je teď na konci karty Dnes jako dvě věty a odkaz. Návrh: sekce „Plán“ se řádky bloků; kapacita jedním údajem vpravo v nadpisu („3 h volno“), bez kalendáře nic. Ukázka: **PlanBlock**.

**A3 – Stavové čipy zrušit.** Tři čipy pod nadpisem nahradit ničím; když nastane problém (offline, konflikt, zastaralý kalendář), jeden tichý řádek. Ukázka: **StatusChip**.

**A4 – Bez pozdravu a podtitulku.** Nadpis „Domů“ (případně dnešní datum vpravo), žádné „Takhle vypadá váš dnešní den.“

## B. Seznamy, detail, zachycení

**B1 – Inbox jako triage.** Specifikace: vyjasnit, naplánovat, přiřadit, označit čekání, odložit, zahodit. Dnes jen zaškrtnout nebo otevřít detail. Návrh: při výběru řádku inspektor vpravo s originálem vstupu a tlačítky *Dnes · Naplánovat · Do projektu · Čeká na · Někdy · Zahodit*; klávesové zkratky pro každou.

**B2 – Detail jako inspektor, ne modální překryv.** Dnes se detail úkolu i projektu otevírá jako panel přes ztmavenou plochu (seznam je nepoužitelný). Návrh: na šířce ≥ 1200 px pravý panel vedle seznamu bez překryvu (3-pane); pod 1200 px samostatný pohled se šipkou zpět; na iPhonu celoplošný sheet. Projekt nahoře: *Cíl · Stav · Další akce · Poslední aktivita · Rizika*, pak úkoly a poznámky. Pole „termín“ a „Oblast“ sjednotit se stylem polí v detailu úkolu (popisek nad polem, `input-bg`, `radius-md`), popisky velkým písmenem.

**B3 – Zachycení více typů.** Dialog „Rychlé zadání“ má jediné pole a výběr Oblasti. Návrh: přepínač *Úkol · Poznámka · Odkaz · Vložit text* nad polem (segmentovaný ovladač), pro „Vložit text“ víceřádkové pole a náhled extrakce s návrhy jako položkami `proposal`. Rozepsaný text se zachová při zavření.

**B4 – Řádek bez podtitulu.** Každý řádek dnes jako podtitul opakuje název seznamu („Doručené“, „Projekty“, „Poznámky“). Návrh: podtitul zrušit; vpravo nejvýše jeden drobný údaj – úkol: datum (červeně po termínu) nebo odhad; projekt: počet otevřených úkolů; poznámka: datum. Ukázka: **TaskRow**.

**B5 – Search s vlastním polem.** Obrazovka Hledání je bez dotazu prázdná. Návrh: velké pole s fokusem, filtry *Vše · Úkoly · Projekty · Poznámky · Lidé* a nedávná hledání. Výsledek je jeden řádek podle pravidel systému: ikona typu, název, dlaždice prostoru a datum vpravo; zdroj a čerstvost (požadavek LUMI-UX-008) ukazuje inspektor vpravo u vybraného výsledku. Nedostupný zdroj jeden tichý řádek nad výsledky.

**B6 – Texty polí Přidat.** Pole na konci každého seznamu úkolů zní „+ Přidat dnes“ i v Doručených a v Kalendáři (`entity-list.tsx:210` doplňuje vždy „Today“). U ostatních typů je špatný tvar: „Přidat projekty“, „Přidat poznámky“. Návrh: „Přidat úkol“, „Přidat projekt“, „Přidat poznámku“ a seznam, do kterého se přidává, ukázat jen pokud není zřejmý.

**B7 – Název v detailu se ořezává.** „Připravit podklady pro investo…“ – titulek v detailu je jednořádkové pole bez zalomení. Návrh: víceřádkové pole s automatickou výškou.

## C. Návrh → schválení → akce (P0)

**C1 – Jedna komponenta ProposalCard pro chat, Home, plán dne i Inbox.** Dnes asistent ukazuje `summary` a seznam „popisek: hodnota“ s tlačítky Potvrdit/Zrušit. Specifikace požaduje: cíl, workspace, hodnoty před → po, související položky, dopad na kalendář a jiné systémy, nevratné účinky, konflikty; po provedení výsledek, audit a Zpět; expirovaný návrh nejde schválit. Návrh:

- Hlavička: štítek **Návrh**, dlaždice a název cílového prostoru a platnost („platí 9 min“) – jediná povolená metadata v hlavičce. Zdroj návrhu a čas vytvoření jsou v auditu.
- Tabulka změn se sloupci *Pole · Teď · Po schválení*; nové hodnoty tučně.
- Blok **Dopady** (kalendář, externí systémy) a **Nevratné** zvýrazněný `warning-soft`.
- Tlačítka *Schválit* (primární) a *Odmítnout*; u expirovaného nebo konfliktního stavu *Schválit* vypnuté s důvodem a *Posoudit znovu*.
- Po schválení se karta přepne na **Provedeno** s plným okrajem, odkazem na audit a *Zpět*, pokud je bezpečné.
- Na desktopu inline v chatu nebo v inspektoru, na iPhonu spodní sheet s rozbalitelnými dopady.

Ukázka: komponenta **ProposalCard** (stavy čeká, expirováno, provedeno).

## D. Kalendář

**D1 – Časová osa místo seznamu.** Pohled Kalendář dnes obsahuje kartu se dvěma hláškami „Kalendář není připojen“ a pod ní celý seznam úkolů. Návrh: denní časová osa (06–22 h) se třemi vizuálně odlišnými vrstvami – událost (plná výplň `surface-subtle`), přijatý blok (plný okraj `accent`), navržený blok (přerušovaný okraj `proposal` + štítek Návrh); vpravo nenaplánované úkoly. Bez připojeného kalendáře jeden prázdný stav s tlačítkem *Připojit kalendář* a vysvětlením, že přesný volný čas nelze nabídnout. Seznam všech úkolů z pohledu odstranit (patří do Dnes/Nadcházející).

## E. iPhone

**E1 – První výřez Home.** Na 390 × 844 je vidět jen pozdrav, tři čipy a jedno doporučení; FAB překrývá „Zobrazit vše“. Po A1, A3 a A4 se do prvního výřezu vejdou doporučení i Dnes. Spodní padding obsahu = navigace + FAB + `space-4`.

**E2 – Today bez prázdné karty.** „Lumi · právě teď – Žádný úkol právě neběží.“ zobrazit jen při běžící relaci. Plán dne jako řádky s odhadem vpravo, akce *Jiný čas · Zítra · Neplánovat* v detailu položky.

**E3 – Sheet Více.** Obsahuje „Zavřít nabídku“ jako položku seznamu, položky bez ikon a FAB překrývá poslední položku (Nastavení). Při otevřeném sheetu svítí v navigaci aktivní dvě položky (Kalendář i Více). Návrh: zavírání úchytem a tlačítkem ✕ v hlavičce, skupiny *Plánování* (Nadcházející, Projekty, Oblasti, Poznámky, Hledání), *Filtry* (Po termínu, Kdykoli, Někdy, Dokončené), *Systém* (Kontext, Agenti, Nastavení), FAB skrýt při otevřeném sheetu, aktivní jen Více. Ukázka: **BottomNav**.

**E4 – Hlavička na iPhonu.** Přepínač „Osobní⌄“ má 11 px a malý cíl. Návrh: dlaždice prostoru s názvem vlevo (44 px, viz W2), přepínač tématu přesunout do Nastavení.

## F. Design systém a přístupnost

**F1 – Paleta a ikony ve stylu Things.** Nová paleta v `tokens.json` nahrazuje současné hodnoty z `globals.css`: bílá plocha, šedý sidebar `#f3f4f6`, modrý `accent` `#1a6ef0`, ikony `icon-*` (modrá Doručené, žlutá hvězda Dnes, červená Nadcházející, fialové Projekty, tyrkysové Oblasti, oranžové Poznámky, zelený Kalendář). Ikony se mění v šesti místech: Domů ⌂ → SVG domeček (glyf je drobný a nevýrazný), Dnes ○ → plná hvězda, Poznámky ▤ → list se zahnutým rohem, Kalendář ▦ → kalendářový list s kroužky a dny, Hledání ⌕ → větší SVG lupa 16 px, Více ••• → tři SVG tečky vycentrované v ikoně (text ••• sedí mimo střed). Stejné ikony a barvy dostane spodní navigace na iPhonu (dnes jednobarevná). Aktivní položka navigace: výrazné pozadí v barvě prostoru `ws-*-soft` a tučný text místo šedé `selected`. Žlutá hvězda má na světlém sidebaru jen 1.7:1; je vždy s popiskem.

**F2 – Barvy ikon podle `nth-child`.** `globals.css` barví ikony sidebaru přes `nav button:nth-child(n)`; přidání nebo skrytí položky posune barvy. Návrh: třída podle pohledu (`.nav-inbox`) a tokeny `nav-*`.

**F3 – `on-accent` pro všechna primární tlačítka.** V tmavém tématu má bílý text na `accent` (#9d99f5) jen 2.5:1. Tmavý text je dnes vynucený pouze u mobilního FAB. Návrh: token `on-accent` pro všechna primární tlačítka.

**F4 – Okraj ovládacích prvků a fokus.** `line` a `line-strong` mají vůči `surface` 1.4 a 1.7:1; pole se rozlišují jen výplní. Návrh: `control-border` (≥ 3.2:1) pro pole a sekundární tlačítka, `focus-ring` jako plný 2px obrys všude.

**F5 – Dvojí `:root` a zbytky starého stylu.** `globals.css` má dva bloky `:root` (řádek 1 a 2468) s odlišnými hodnotami (`--accent` #6155e7 vs. #5258cc) a starší pravidla s pevnými barvami (`.list { background: #fff }`, `h3 { color: #999 }`). Celkem 170 unikátních hex hodnot proti 34 tokenům. Návrh: první `:root` odstranit, pevné barvy převést na tokeny ze `tokens.json`, styl rozdělit na `tokens.css` + komponenty.

**F6 – Stupnice.** 20 různých velikostí písma (10–36 px), 12 rádiusů (5–20 px) a 11 vah. Návrh: písmo podle `type` tohoto systému (11, 12, 13, 14, 15, 16, 22, 42), rádiusy `radius-xs`…`radius-pill`, váhy 400/540/600/650/700/720.

**F7 – (zrušeno)** Výměna ikon za jinou sadu se nenavrhuje.

**F8 – Levé barevné okraje.** Plán dne a řádky po termínu používají levý barevný okraj (4 px) jako jediný nosič stavu. Návrh: stav vyjádřit slovem nebo datem v barvě stavu vpravo v řádku (viz TaskRow); okraj ponechat jen pro rozlišení návrh/potvrzeno (přerušovaný vs. plný, po celém obvodu).

## Pořadí dodání

1. **Rychlé opravy (S):** B6, B7, E3, F2, F3 – texty, CSS, bez změny dat.
2. **Tiché UI + prostor:** A1, A3, A4, B4, E1, E2 a W1–W3 – nejviditelnější změna, převážně prezentační; W1 v pevné variantě nemění data, případná volba v Nastavení až po rozhodnutí vlastníka.
3. **P0 mezery:** C1 ProposalCard (chat + mobilní sheet), B1 triage Inboxu, B2 inspektor a detail projektu.
4. **Systém:** F4, F5, F6 – sjednocení tokenů v `globals.css` podle `tokens.json`.
5. **P1:** D1 časová osa, B3 typy zachycení, B5, A2, F8.

Každý krok projde podle `AGENTS.md` implementací v samostatné větvi a dvěma nezávislými testery (funkce/UX/mobil a regrese/edge cases); kontrastní a jazykový e2e audit (`e2e/contrast.spec.ts`, `e2e/language.spec.ts`) pokrývá F3, F4 a W1.
