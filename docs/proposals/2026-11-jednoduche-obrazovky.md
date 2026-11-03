# Lumi — jednoduché hlavní obrazovky

**Schválený návrh cílového uspořádání, 3. 11. 2026.** Schémata ukazují pořadí a obsah, nikoli konečné rozměry či implementovaný stav. Závazná pravidla obsahuje [UX/UI specifikace](../UX-UI.md), včetně pravidel pro rozsahy, Oblasti, časovou osu a akce. Příkladová data jsou smyšlená. Některé funkce jsou dosud cílové.

## Společný rámec

- Bílé nebo jemně tónované pozadí, systémové písmo, jeden výrazný nadpis. Barva pomáhá orientaci, význam ale vždy nese i text. Neobalovat každý řádek kartou.
- Nahoře přepínač **Můj plán / Osobní / Sdílené** a dostupné hledání; rozsah je čitelný a není novým prostorem. Globální Lumi Chat a rychlé přidání zůstávají dostupné. Na telefonu spodní lišta **Domů · Doručené · Dnes · Projekty · Více**; Kalendář je ve Více. Tlačítko `＋` otevře zachycení jedním klepnutím.
- Stav ukázat, když ovlivňuje práci: „Čeká na synchronizaci“, „Kalendář není aktuální“, „Konflikt“. Stavy návrhu a potvrzeného bloku se rozlišují textem. Žádná interní ID, revize, technické názvy pravidel ani diagnostika na těchto obrazovkách nebo v detailu úkolu, ani po rozbalení.
- Schémata nejsou úplný seznam možností: sekundární akce se zobrazí v nabídce nebo detailu, musí však být dosažitelné dotykem i klávesnicí. Dotykové cíle alespoň 44 × 44 px, viditelný focus, čtečka obrazovky, větší text a bezpečné okraje telefonu.

## 1. Domů

```text
Můj plán ▾                         Hledat
Domů

Pozornost
  Odevzdat podklady                    ›
  Termín je zítra · podle termínu úkolu
  Ověřeno v 9:42

Dnes                              Vše ›
  10:00  Porada                     30 min
  ○ Připravit nabídku               45 min

                              ＋
Domů  Doručené  Dnes  Projekty  Více
```

Pozornost má nejvýše pět doporučení, další na vyžádání. Klepnutí otevře související položku a její zdroj; odložení a skrytí jsou dostupné v detailu nebo nabídce položky. Dnešní přehled je stručný a vede do Dnes. Je-li doporučení prázdné, zobrazí klidný text „Teď nic nepotřebuje pozornost.“ Kapacita se uvádí jen z čerstvého kalendáře. Při zastaralém zdroji se místo ní ukáže příslušný stav; návrh a potvrzená položka se nezaměňují.

## 2. Doručené

```text
Můj plán ▾                         Hledat
Doručené                         Filtry

○ Zavolat účetní                      ›
  Úkol
  Poznámky ze schůzky                 ›
  Vložený text · čeká na kontrolu
  Z pošty                             ›

                              ＋
Domů  Doručené  Dnes  Projekty  Více
```

Filtry se otevřou v sheetu; aktivní filtr je viditelný i po zavření. Typ se uvádí tam, kde pomáhá rozlišit vstup. Otevřený vstup zachová originál a dovolí upravit návrhy, naplánovat, přiřadit, označit čekání, odložit nebo zahodit. Výtažek se nepotvrdí sám. „Z pošty“ vede k připojeným zprávám; jejich dostupnost a oprávnění zůstávají zachována. Prázdný stav: „Doručené jsou prázdné“ a možnost přidat položku.

## 3. Dnes

```text
Můj plán ▾                         Hledat
Dnes

Průběh dne
  09:00 ┌ Porada · 30 min ┐
        └─────────────────┘
  10:00 ┌ Připravit nabídku ┐
        │ Potvrzený blok    │
        └───────────────────┘
  11:00 ┌ Odeslat podklady  ┐
        └ Návrh · 30 min ───┘

Úkoly
  ○ Připravit nabídku        45 min  Kdy ▾
  ○ Zavolat účetní           15 min  Kdy ▾
                              ＋
Domů  Doručené  Dnes  Projekty  Více
```

Časová osa je schematická: skutečné výšky odpovídají délce podle [specifikace](../UX-UI.md#uxui-cílového-produktu--target-requirement); překryvy, celodenní události a krátké položky zachovávají její pravidla. Položku lze otevřít; návrh bloku vede ke schválení. Běžný úkol zůstává i v seznamu, neboť blok je rezervace času. Úkol vzniklý z události je jen na ose a do seznamu se neduplikuje. „Kdy“ nabízí odložení bez změny termínu; dokončení a smazání jsou dostupné i z detailu. Pokud je odhad nebo důvod pořadí známý, ukáže se srozumitelně. Offline změna má viditelný stav.

## 4. Kalendář

```text
‹ Více                      Kalendář
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
Přejít na Dnes
```

Po otevření položky se ukáže její čas, typ, případný konflikt a dostupná akce. Skrytá událost je jen v Kalendáři označená „Skryto“ a lze ji znovu zobrazit; pravidla pro obsazenost a události převedené na úkol zůstávají podle specifikace. U nepřipojeného kalendáře místo tvrzení o kapacitě zobrazit „Kalendář není připojen“ a **Připojit**; u zastaralého „Kalendář není aktuální“ a **Obnovit**, spolu s dostupnými uloženými událostmi bez tvrzení o volném čase.

## 5. Projekty a detail projektu

```text
Můj plán ▾                         Hledat
Projekty

Práce
  Nový web                         3/7 kroků
  Další krok: Připravit nabídku       ›

Osobní
  Dovolená                         1/4 kroků
  Další krok: Vybrat termín          ›
                              ＋
Domů  Doručené  Dnes  Projekty  Více
```

Projekt se otevře jako samostatná stránka s návratem do seznamu: název a stav, stručný kontext „Proč“, cíle a „Hotovo, když“, úkoly, poznámky a zdroje, následované podrobnostmi. Zůstávají dostupné průběh, další krok, vysvětlená rizika, vztahy, historie a stav ukládání dle [specifikace projektu](../UX-UI.md). Prázdné volitelné části se nevnucují; přidání zůstává snadno dostupné. Detail úkolu se otevírá nad projektem a po zavření se uživatel vrátí na stejné místo.

## 6. Detail úkolu a rychlé přidání

```text
‹ Zpět                       Hotovo

○ Připravit nabídku
  Dnes                        Kdy ▾
  Termín 12. listopadu
  Projekt: Nový web

Poznámka
  Připravit podklady pro klienta.

＋ Přidat podrobnosti
Dokončit          Odložit          ⋯
```

Ukazují se vyplněné a pro úkol relevantní údaje; přes „Přidat podrobnosti“ lze přidat například termín, projekt, odhad, opakování nebo kontrolní seznam. Další akce včetně smazání jsou v nabídce; smazání umožní bezpečné vrácení. V případě problému se objeví stav a další krok, např. „Změna čeká na synchronizaci“. Detail lze zavřít viditelným tlačítkem, rozepsaný obsah se neztratí.

`＋` otevře jednoduché pole „Co chcete zachytit?“ s viditelnou cílovou Oblastí a tlačítkem **Uložit**. Cílová Oblast určuje soukromý nebo sdílený prostor; sdílená volba ukáže členy a vyžádá výslovný souhlas, u položky v projektu je Oblast zděděná. Volitelné návrhy jsou upravitelné, jsou označeny jako návrhy a nic samy nepotvrzují. Při nedostupné síti zůstane rozepsaný text a zobrazí se stav uložení.

## 7. Schválení změny

```text
Schválit změnu                         Zavřít

Přesunout „Připravit nabídku“?
Prostor: Osobní
Oblast: Nezařazeno · soukromá
Před: dnes
Po: zítra
Termín 12. listopadu se nemění.

[Odmítnout]                 [Schválit]
```

Příklad je pouze pro změnu plánovaného dne v soukromé Oblasti. U sdílené Oblasti musí být vidět i oprávnění členové. Skutečný návrh musí uvést všechny relevantní související položky, dopady na kalendář a jiné systémy, nevratné účinky a konflikty. Po úspěchu ukáže výsledek a umožní prohlédnout historii; **Zpět** nabídne jen tehdy, kdy je bezpečné. Zastaralý či konfliktní návrh nelze schválit a nabízí nové posouzení. Detail nelze zkrácením připravit o informace nutné k rozhodnutí.

## Desktop a ověření

Desktop má postranní navigaci **Domů, Doručené, Dnes, Nadcházející, Projekty, Kalendář**, nahoře rozsah a globální hledání. V pracovních seznamech se detail otevře v pravém panelu; projekt má vlastní stránku. Home a Kalendář využijí širší obsah. Při zúžení se panel změní na samostatný pohled; návrat zachová kontext i rozepsaný obsah.

Při následné realizaci ověřit mobil a desktop, dotyk/klávesnici/čtečku, velký text, prázdné a chybové stavy, odpojený a zastaralý kalendář, čekající synchronizaci, konfliktní schválení a přepnutí rozsahu bez úniku dat. Časová osa, schválení a sdílené rozsahy zůstávají omezené skutečně dodanými schopnostmi aplikace.
