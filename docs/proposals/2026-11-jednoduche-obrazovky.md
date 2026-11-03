# Lumi — jednoduché hlavní obrazovky

**Schválený návrh cílového uspořádání, 3. 11. 2026.** Schémata ukazují pořadí a obsah, nikoli konečné rozměry či implementovaný stav. Závazná pravidla obsahuje [UX/UI specifikace](../UX-UI.md), včetně pravidel pro rozsahy, Oblasti, Today a akce. Starší statické náhledy design systému zachycují dřívější rozložení a pro tyto části jsou historické. Příkladová data jsou smyšlená. Některé funkce jsou dosud cílové.

## Společný rámec

- Bílé nebo jemně tónované pozadí, systémové písmo, jeden výrazný nadpis. Barva pomáhá orientaci, význam ale vždy nese i text. Neobalovat každý řádek kartou.
- Nahoře přepínač **Můj plán / Osobní / Sdílené** a dostupné hledání; rozsah je čitelný a není novým prostorem. Globální Lumi Chat a rychlé přidání zůstávají dostupné. Na telefonu je první celé rolovatelné menu s přímými cíli včetně všech oprávněných projektů v právě zvoleném rozsahu; Today, projekt a detail se otevírají jako další celé stránky se Zpět. Tlačítko `＋` otevře zachycení jedním klepnutím.
- Stav ukázat, když ovlivňuje práci: „Čeká na synchronizaci“, „Kalendář není aktuální“, „Konflikt“. Stavy návrhu a potvrzeného bloku se rozlišují textem. Žádná interní ID, revize, technické názvy pravidel ani diagnostika na těchto obrazovkách nebo v detailu úkolu, ani po rozbalení.
- Schémata nejsou úplný seznam možností: sekundární akce se zobrazí v nabídce nebo detailu, musí však být dosažitelné dotykem i klávesnicí. Dotykové cíle alespoň 44 × 44 px, viditelný focus, čtečka obrazovky, větší text a bezpečné okraje telefonu.

## 0. Kořenové menu telefonu

```text
Můj plán ▾                     Hledat  ＋  Lumi
Home / Denní brief
Doručené
Dnes
Nadcházející
Kalendář
Poznámky
Oblasti
Uložené filtry
Projekty
  Nový web
  Dovolená
  … všechny další oprávněné projekty ↓
Nastavení
```

Menu je jedna rolovatelná obrazovka bez „Více“ a bez povinného rozbalení. Projekty nejsou omezené počtem sedm; rozsah filtruje přístupná data. Klepnutí na Dnes nebo projekt odsune menu doleva a přivede další celou stránku zprava; úkol či poznámka se otevře stejným směrem o úroveň hlouběji. Zpět pohyb obrátí. Tlačítko **Zpět** i Zpět prohlížeče vrací přesnou předchozí obrazovku, posun, rozepsaný obsah a fokus na původní ovladač (nebo bezpečný nadpis/seznam) v téže oprávněné identitě a rozsahu; přímý odkaz a návrat po změně oprávnění přístup znovu ověří. Přechod respektuje omezený pohyb; vše funguje i klávesnicí bez gesta. Odkaz na konkrétní projekt/úkol/poznámku nese jeho stabilní neprůhledný identifikátor; přímé otevření v nové relaci či obnovení stránky nezávisí na paměti navigačního zásobníku. Každé načtení znovu ověřuje serverová oprávnění k cílové Oblasti; bez přístupu se název ani náhled neukáže. Není-li historie v zásobníku, Zpět vede na bezpečný seznam.

## 1. Domů

```text
‹ Menu  Můj plán ▾               Domů

Pozornost
  Odevzdat podklady                    ›
  Termín je zítra                   Proč? ▾

Dnes                              Vše ›
  10:00  Porada                     30 min
  ○ Připravit nabídku               45 min

                              ＋
```

Pozornost má nejvýše pět doporučení, další na vyžádání. Přístupné **Proč?** ukáže například „Podle termínu úkolu · vyhodnoceno 3. 11. v 9:42“ a dovolí otevřít oprávněný zdroj. Zastaralost, nejistota či konflikt jsou vidět ihned bez rozbalení; neznámý čas zůstává neznámý. Klepnutí otevře související položku a její zdroj; odložení a skrytí jsou dostupné v detailu nebo nabídce položky. Dnešní přehled je stručný a vede do Dnes. Je-li doporučení prázdné, zobrazí klidný text „Teď nic nepotřebuje pozornost.“ Kapacita se uvádí jen z čerstvého kalendáře. Při zastaralém zdroji se místo ní ukáže příslušný stav; návrh a potvrzená položka se nezaměňují.

## 2. Doručené

```text
‹ Menu  Můj plán ▾           Doručené
Filtry

○ Zavolat účetní                      ›
  Úkol
  Poznámky ze schůzky                 ›
  Vložený text · čeká na kontrolu
  Z pošty                             ›

                              ＋
```

Filtry se otevřou v sheetu; aktivní filtr je viditelný i po zavření. Typ se uvádí tam, kde pomáhá rozlišit vstup. Otevřený vstup zachová originál a dovolí upravit návrhy, naplánovat, přiřadit, označit čekání, odložit nebo zahodit. Výtažek se nepotvrdí sám. „Z pošty“ vede k připojeným zprávám; jejich dostupnost a oprávnění zůstávají zachována. Prázdný stav: „Doručené jsou prázdné“ a možnost přidat položku.

## 3. Dnes

```text
‹ Menu  Můj plán ▾               Dnes

Události
  09:00  Porada                         30 min

Úkoly
  ○ Připravit nabídku                45 min
    Rezervováno 10:00–10:45 · Kdy ▾
  ○ Odeslat podklady                 Kdy ▾
    Lumi navrhuje blok 11:00 · Schválit návrh
  ○ Zavolat účetní                  15 min
                              ＋
```

Výchozí Dnes má kompaktní události a jediný seznam úkolů. Rezervovaný čas i návrh bloku se ukazuje přímo u úkolu; akční úkol se neduplikuje. Úkol převedený z události je jen jedním úkolem v seznamu a v souhrnu/kapacitě se počítá jednou. Plná časová osa je v Kalendáři nebo se v Dnes výslovně zapne. Běžné řádky rostou podle obsahu, ne podle odhadu; dotykový cíl má nejméně 44 px. Přímé ruční „Kdy → zítra“ v bezpečném rozsahu se uloží hned s Undo a nemění termín; návrh bloku od Lumi vyžaduje schválení. Offline změna má viditelný stav.

## 4. Kalendář

```text
‹ Menu  Můj plán ▾          Kalendář
Dnes                         Obnovit

  09:00 ┌ Porada · 30 min ┐
        └─────────────────┘
  10:00 ┌ Nabídka           ┐
        │ Potvrzený blok    │
        └───────────────────┘
  11:00 ┌ Podklady          ┐
        └ Návrh · 30 min ──┘

Bez času
  ○ Zavolat účetní         15 min  Kdy ▾
Příštích 7 dní                      ›
Otevřít Dnes
```

Po otevření položky se ukáže její čas, typ, případný konflikt a dostupná akce. Skrytá událost je jen v Kalendáři označená „Skryto“ a lze ji znovu zobrazit; pravidla pro obsazenost a události převedené na úkol zůstávají podle specifikace. U nepřipojeného kalendáře místo tvrzení o kapacitě zobrazit „Kalendář není připojen“ a **Připojit**; u zastaralého „Kalendář není aktuální“ a **Obnovit**, spolu s dostupnými uloženými událostmi bez tvrzení o volném čase.

## 5. Projekty a detail projektu

```text
‹ Menu  Můj plán ▾           Projekty

Práce
  Nový web                         3/7 kroků
  Další krok: Připravit nabídku       ›

Osobní
  Dovolená                         1/4 kroků
  Další krok: Vybrat termín          ›
                              ＋
```

Řádek projektu má název, průběh a nejvýše jeden další krok nebo aktuální problém. Projekt se otevře jako samostatná stránka se Zpět do skutečného původního pohledu (kořenové menu, seznam, hledání či Oblast): název a stav, hned poté úkoly; kontext „Proč“, cíle a „Hotovo, když“, poznámky a zdroje se otevírají na vyžádání. Zůstávají dostupné průběh, další krok, vysvětlená rizika, vztahy, historie a stav ukládání dle [specifikace projektu](../UX-UI.md). Prázdné volitelné části se nevnucují; přidání zůstává snadno dostupné. Detail úkolu je další celá stránka nad projektem; Zpět vrátí přesné předchozí místo. Právo upravovat kontext projektu nezávisí na vybraném rozsahu Můj plán / Osobní / Sdílené: soukromý vlastník a oprávněný sdílený editor/admin mohou měnit povolená pole, viewer jen čte.

## 6. Detail úkolu a rychlé přidání

```text
‹ Zpět na projekt · Můj plán

○ Připravit nabídku
  Kdy: Dnes ▾ · Termín 12. listopadu
  Projekt: Nový web

Poznámka
  Připravit podklady pro klienta.

Podrobnosti ▾  Odhad, opakování nastaveny
⋯
```

Výchozí detail ukazuje název a jediný kroužek dokončení, poznámku či kontrolní seznam a kompaktní Kdy, termín a projekt. I vyplněný odhad, opakování a jiné sekundární údaje jsou v jediném přístupném rozbalení, které naznačuje, co je nastavené, a umožní další vlastnosti přidat. Oprávnění, sdílení, konflikt a chyba zůstávají viditelné hned. Další akce včetně smazání jsou v nabídce; smazání umožní bezpečné vrácení. V případě problému se objeví stav a další krok, např. „Změna čeká na synchronizaci“. Na telefonu se celostránkový detail vrací jediným **Zpět** na původní stránku; na desktopu se inspektor zavírá tlačítkem **Zavřít**. Rozepsaný obsah se zachová jen v téže oprávněné identitě a rozsahu.

`＋` otevře jednoduché pole „Co chcete zachytit?“ s viditelnou cílovou Oblastí a tlačítkem **Uložit**. Cílová Oblast určuje soukromý nebo sdílený prostor; sdílená volba ukáže členy a vyžádá výslovný souhlas, u položky v projektu je Oblast zděděná. Volitelné návrhy jsou upravitelné, jsou označeny jako návrhy a nic samy nepotvrzují. Při nedostupné síti zůstane rozepsaný text a zobrazí se stav uložení.

## 7. Schválení změny

```text
Návrh Lumi z denního plánu          Zavřít

Přesunout „Připravit nabídku“?
Prostor: Osobní
Oblast: Nezařazeno · soukromá
Před: dnes
Po: zítra
Termín 12. listopadu se nemění.

[Odmítnout]                 [Schválit]
```

Příklad je návrh **Lumi** spuštěný z Plánu dne, a proto vyžaduje výslovné schválení. Přímá ruční změna „Kdy → zítra“ v nízkorizikovém rozsahu tento panel neotvírá: uloží se hned s bezpečným Undo. Při posunu za termín zůstává potřebné potvrzení. U sdílené Oblasti musí být vidět i oprávnění členové. Skutečný návrh musí uvést všechny relevantní související položky, dopady na kalendář a jiné systémy, nevratné účinky a konflikty. Po úspěchu ukáže výsledek a umožní prohlédnout historii; **Zpět** nabídne jen tehdy, kdy je bezpečné. Zastaralý či konfliktní návrh nelze schválit a nabízí nové posouzení. Detail nelze zkrácením připravit o informace nutné k rozhodnutí.

## Desktop a ověření

Desktop má trvalý rolovatelný sidebar s přímými cíli **Domů, Doručené, Dnes, Nadcházející, Projekty, Kalendář, Poznámky, Oblasti, uložené filtry** a všemi oprávněnými projekty v právě zvoleném rozsahu, nahoře rozsah a globální hledání. V pracovních seznamech se detail otevře v pravém panelu; projekt má vlastní stránku. Home a Kalendář využijí širší obsah. Na telefonu jsou projekt, úkol a poznámka plné navazující stránky; Zpět obnoví předchozí stránku, posun i rozepsaný obsah.

Při následné realizaci ověřit mobil a desktop, dotyk/klávesnici/čtečku, velký text, prázdné a chybové stavy, odpojený a zastaralý kalendář, čekající synchronizaci, konfliktní schválení a přepnutí rozsahu bez úniku dat. Časová osa, schválení a sdílené rozsahy zůstávají omezené skutečně dodanými schopnostmi aplikace.
