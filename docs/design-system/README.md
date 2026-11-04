# Lumi — design systém a stav implementace

> **Závazný cílový design: Lumi Design v1.0, schváleno 4. 11. 2026.** Referenční pravidla určují [UX-UI.md](../UX-UI.md#lumi-design-v10--závazné-grafické-principy-schváleno-2026-11-04), [PRODUCT.md](../PRODUCT.md#lumi-fr-013) a [textový návrh obrazovek](../proposals/2026-11-jednoduche-obrazovky.md). Vizuální kontrakt je **cílový**, nikoli již implementovaný. Staré popisy pracovních/rodinných *prostorů* a mobilního kořenového menu jsou **nahrazené** novějšími rozhodnutími.

## Zdroj pravdy, verze a implementační hranice

- [lumi-v1-target-tokens.json](lumi-v1-target-tokens.json): **schválená cílová referenční paleta a stavové invarianty**, oddělená od kódu. Je výchozím podkladem pro implementační PR a kontrastní testy.
- [tokens.json](tokens.json): **současné legacy runtime tokeny** (původní modrý `accent`, `ws-work`, `ws-family`, `ws-all`) pro stále běžící staré UI. **Nejsou závaznou paletou pro nové obrazovky.**
- [tokens.css](tokens.css): vygenerovaný výstup ze současného `tokens.json` příkazem `node scripts/design-tokens.mjs`. **Nikdy neupravovat ručně.** Povýšení Lumi v1 do runtime je samostatné cílené UI PR s úpravou kanonických tokenů, regenerací, kontrastními kontrolami a ověřením obou témat. Samotná změna dokumentů nemění běžící vzhled.
- `components/<Název>/README.md` a `preview.html`: ilustrativní pravidla a statické ukázky. Mají odrážet cílový Lumi v1, ale **nejsou důkazem dodaného React UI**. Přístup ke skutečné autorizační policy ověřuje server, ne CSS ani ukázka.
- [zmeny-ui.md](zmeny-ui.md): **historický plán a audit před v1.0**, není konkurenčním návrhem. Cíl je určen UX/UI a tímto dokumentem.

## Rozsahy, Oblasti a význam barev

V produktu jsou **jen dva datové prostory Osobní a Sdílený**. Jeden **globální čtecí přepínač celé aplikace Vše / Osobní / Sdílené** má tři sémantické barvy: **Vše fialová `#8B5CF6`**, **Osobní zelená `#16A34A`**, **Sdílené modrá `#2563EB`**. Vše znamená všechna data autorizovaná serverem, včetně nepřidělené sdílené práce, **ne** starší interní pohled `my-plan`. Volba čtecího rozsahu není zápisovou pravomocí.

**Můj plán** je výchozí osobní denní obrazovka, **nikoli čtvrtý scope ani třetí prostor**; i při zvoleném Vše ukazuje jen moje soukromé a mně přidělené aktivní sdílené úkoly. Oblasti jsou organizační štítky a zároveň jediná kanonická hranice sdílení projektů a úkolů; oprávnění při čtení i zápisu vynucuje server.

V Mém plánu i Projektech se položky seskupují podle Oblasti do **jemně podbarvených bloků bez viditelných nadpisů oblastí/prostorů a bez opakovaných štítků**. Schválené ilustrační odstíny: osobní `#DCFCE7` (zelená), práce `#DBEAFE` (modrá), rodina `#FCE7F3` (růžová). Název Oblasti je stále přístupný čtečce a viditelný v detailu či před sdílením; zabarvení **nemůže** nahradit vysvětlení, kdo bude data číst.

## Stavové ikony (nezávislé na barvě rozsahu a Oblasti)

| Položka | Běžná nedokončená | Vyžaduje pozornost | Dokončená |
|---|---|---|---|
| **Úkol** | **Prázdný čtverec** s neutrální konturou, bez fajfky | Prázdný **čtverec s červenou nebo oranžovou konturou**, bez výplně a fajfky | Tlumený **šedý čtverec s fajfkou**, šedý název |
| **Projekt** | **Prázdný kruh** s neutrální konturou, bez fajfky | Prázdný **kruh s červenou nebo oranžovou konturou**, bez výplně a fajfky | Tlumený **šedý kruh s fajfkou**, šedý název |

- **Není** speciální stav „probíhá“, „v akci“ ani „rozpracováno“. Pozornost se neurčuje z barvy skupiny; každé zvýraznění musí mít pochopitelný textový důvod. **Dokončení celého projektu** používá explicitní potvrzení a nikdy potají nedokončí všechny jeho dosud otevřené úkoly.
- **Soukromá priorita** sdíleného úkolu je **per-user**; ikona podle osobní priority se smí zobrazit pouze dotčenému uživateli. Sdílený deadline nebo jiné oprávněné společné attention pravidlo smí vést ke zvýraznění u dalších oprávněných členů, bez odhalení osobního stavu jiného člověka. U stavů využít přístupné `aria-label` a kontrastní tah.
- **Projektový seznam**: kruh + název **stejné velikosti a tučnosti jako název úkolu v Mém plánu**, nejvýše jedna krátká věta o aktuálním problému/dalším kroku. **Žádné počty úkolů, poměr dokončení, progress bar, štítky Oblastí ani nadpisy prostorů.** Postup zůstává v **detailu projektu**.
- **Návrhy Lumi** mají rozpoznatelný fialový/fialovorůžový akcent, hvězdu a výslovný štítek **„Návrh Lumi“** se schválením/odmítnutím. Neschválená změna není hotová akce a nesmí se vizuálně zaměnit s potvrzenou rezervací.

## Navigace a kalendář

- **iPhone:** začíná **Mým plánem**. Spodní navigace má přesně **Můj plán / Kalendář / Projekty / Více**; Hledat je nahoře, stejně jako dostupné rychlé zachycení a Lumi Chat. **Více** obsahuje Home / Denní brief, Doručené, Dnes, Nadcházející, Poznámky, Oblasti, filtry, integrace a nastavení. Projekty jsou samostatnou záložkou, bez pevného limitu oprávněných položek. Spodní navigaci se **nesmí** nahrazovat starým kořenovým rolovatelným menu.
- **Mobilní Kalendář:** vždy **jediný vybraný den** na časové ose; nahoře vodorovný řádek bublinek se **zkratkou dne nad číslem**. Nevybrané minulé dny šedé, vybraný den fialový i v minulosti, dnes zvlášť dostupné. **Žádný přepínač 1/3/7 dní na mobilu.** Potvrzené rezervace a návrhy bloků jsou nezaměnitelné; událost převedená na úkol má jedinou akční reprezentaci.
- **Desktop:** trvalý přehledný sidebar s přímými cíli a všemi oprávněnými projekty podle globálního filtru, hledání a Lumi Chat v hlavičce, projekt má vlastní stránku; detail úkolu může být v pravém inspektoru. Detail/Back/Forward/reload/revokace přístupu mají přednost před animací.

## Text, přístupnost a aktualizace

SF Pro / systémové fonty; nadpisy úkolů i projektů orientačně **16–17 px, váha 650**; zbytek metadata střídmě. Všechny cíle pro dotyk nejméně **44 × 44 px** a přístupné pro klávesnici a VoiceOver. Kontrast běžného textu alespoň **4,5:1**, důležitých netextových kontur **3:1** vůči příslušnému podkladu, včetně pastelových skupin a tmavého režimu. Referenční oranžová `#F59E0B` a některé tlumené šedé samy o sobě nemusejí vyhovět jako tenký tah na bílém/pastelovém podkladu: použít kontrastnější sémantický odstín a ověřit testem, **zachovat ale stejné červené/oranžové/šedé významy a obrysový/zaškrtnutý tvar**.

Přístupné `Proč?` uvádí příčinu pozornosti, zdroj a čerstvost; offline, konflikt, revokace a pending se nikdy neskrývají jen kvůli čistému vzhledu. Vytváření/přesun do sdílené Oblasti musí ukázat výslovný rozsah zveřejnění a vyžaduje potvrzení. Přepínač rozsahu a lokální cache samy nejsou serverovou autorizací. **Aktualizace design systému nezapíná cílový R3 backend ani produkční cutover.**
