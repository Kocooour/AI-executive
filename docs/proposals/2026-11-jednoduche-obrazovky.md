# Lumi — hlavní obrazovky, Design v1.0

**Schválený směr 4. 11. 2026.** Tento vizuální kontrakt nahrazuje starší mobilní kořenové menu z 3. 11. a vychází z uživatelem vybraného a iterativně upraveného mockupu. Neznamená dodanou implementaci. Závazná bezpečnostní, datová a akceptační pravidla zůstávají v [UX-UI.md](../UX-UI.md), [PRODUCT.md](../PRODUCT.md) a [ARCHITECTURE.md](../ARCHITECTURE.md). Obrázkové mockupy jsou ilustrační, přednost mají níže uvedené výslovné invariance.

## Společná grafika

- Bílé plochy, jemná pastelová výplň skupin, střídmé zaoblení a stíny, minimum rámů. Výrazné tmavé názvy úkolů a projektů, sekundární text stále čitelný. Písmo SF Pro / systémové, H1 přibližně 32 px, sekce 20 px, **úkol i projekt 16–17 px se shodnou tučností 650**, podrobnosti 13–14 px. Dotykové cíle nejméně 44 × 44 px.
- **Rozsahy v navigaci:** **Vše** fialová **#8B5CF6**, **Osobní** zelená **#16A34A**, **Sdílené** modrá **#2563EB**. Vše znamená opravdu **veškerý obsah s platným oprávněním ke čtení** napříč Osobním a Sdíleným, nikoli jen přidělené úkoly. **Můj plán** zůstává úvodní osobní pracovní obrazovkou (vlastní soukromé + mně přidělené sdílené úkoly) s identitou Lumi, **není další hodnotou globálního filtru** ani třetím prostorem či zápisovým cílem; barva nikdy nepřidává práva.
- **Oblasti ve skupinách:** osobní jemná zelená **#DCFCE7**, práce jemná modrá **#DBEAFE**, rodina jemná růžová **#FCE7F3**. Jiné Oblasti mají konzistentně jemné pozadí. Barva Oblasti **nikdy** nerozhoduje o barvě dokončovací ikony.
- **Nedokončená běžná položka:** neutrální **prázdný obrys bez fajfky**. Priorita / vyžaduje pozornost: **pouze červená #EF4444 nebo oranžová #F59E0B kontura prázdné ikony, bez výplně a bez fajfky**, se srozumitelným důvodem v dostupném textu. Hotovo: **šedá #94A3B8 s fajfkou**, text i ikona tlumené a případně přeškrtnuté, ale stále dostatečně kontrastní. **Žádný stav „úkol v akci“ či „rozpracováno“.**
- **Úkol = vždy čtverec. Projekt = vždy kruh.** Platí pro otevřený, urgentní i hotový stav a pro všechny obrazovky. Dokončený projekt je **šedý kruh s fajfkou**, ne čtverec; nedokončený projekt nikdy nemá fajfku. Kruh projektu umožňuje explicitní dokončení projektu, nikoli automatické skryté dokončení všech jeho úkolů.
- **Návrh Lumi:** výrazná fialová/fialovorůžová plocha, původní ikona hvězdy, popis **„Návrh Lumi“** a dostupné **„Posoudit“**. Návrh je jiný než potvrzená rezervace a nikdy se netváří jako provedená změna.
- Zachovat ostatní dosavadní sémantické ikony Lumi (kalendář, hledání, spodní navigace), měnit jen definované stavové ikony. Zde uvedené barvy jsou **cílové hodnoty designu**; současné CSS a design tokeny se neprohlašují za již upravené. Ověřit kontrast světlého i tmavého režimu.

## Navigace

Mobil začíná obrazovkou **Můj plán**, pevné spodní menu má právě čtyři položky: **Můj plán · Kalendář · Projekty · Více**. **Hledání není pátou záložkou**, je dostupné v horní liště. Horní **globální přepínač rozsahu má volby `Vše / Osobní / Sdílené`**, stav je stejný v Projektech a dalších pracovních pohledech. Můj plán má jako úvodní pohled vlastní osobní výběr položek; volby Osobní/Sdílené ho pouze zužují, při Vše zůstává souhrnem **mých** úkolů. Quick Capture, Lumi Chat a oznámení zůstávají snadno dosažitelné.

**Více** je rolovatelný seznam sekundárních cílů: Domů / Denní brief, Doručené, Dnes, Nadcházející, Poznámky, Oblasti, uložené filtry, e-maily, integrace, nastavení a pomoc. **Projekty** mají vlastní záložku a úplný autorizovaný seznam bez umělého limitu. Desktop zachová trvalý levý sidebar, horní hledání a chat, samostatnou stránku projektu a pravý inspektor úkolu/poznámky; mobilní spodní lišta se na desktop nepřenáší.

Přímý odkaz na projekt, úkol či poznámku obsahuje neprůhledný identifikátor; reload / nová relace a Back/Forward fungují bez závislosti na pouze lokální historii. Zpět vrací předchozí seznam, posun, draft a fokus jen pro stále oprávněnou identitu a rozsah. Serverové ACL se kontroluje po otevření, změně identity a revokaci; neautorizovaná data ani náhledy se neukazují. Offline cache je identity-scoped a vzdálená revokace se ověří po znovupřipojení. Klávesnice, VoiceOver a reduced motion fungují bez povinného gesta.

## Můj plán: jednoduchý přehled dne a nejbližší práce

**Dnes** a **Zítra** jsou jasně oddělené časové části. Úkoly jsou uvnitř rozdělené podle Oblastí do **jemně podbarvených bloků, bez jejich viditelných názvů a bez štítků Oblasti u úkolů**. Oblast lze otevřít v detailu a čtečka ji oznamuje jako název skupiny; sdílení či cílový zápis vždy zobrazuje textově plné oprávnění, protože barva sama nestačí.

~~~text
Můj plán                    [Vše ▾]           Hledat  ✦  ＋
Dnes · Po 3. 11.

  [jemně zelený blok – bez viditelného názvu Oblasti]
  □  Zajistit nabíjení v Nových Hamrech
  ☑  Plán další iterace              (hotový – šedá ikona i text)

  [jemně modrý blok – bez viditelného názvu Oblasti]
  □  Dokončit review PR
  [kalendář] Standup – Lumi                    10:00–10:30

  [jemně růžový blok – bez viditelného názvu Oblasti]
  □  Objednat rolety do ložnice
  [kalendář] Vyzvednout děti                   15:30

  ✦  Návrh Lumi – Přesunout nabídku?            Posoudit ›

Zítra · Út 4. 11.
  ...
────────────────────────────────────────────────────────
Můj plán            Kalendář             Projekty            Více
~~~

Kalendářová událost má **ikonu kalendáře**, nikoli dokončovací čtverec. Převod události na kanonický úkol vytvoří **jediný akční úkol**; rezervovaný čas či návrh bloku patří do jeho řádku, nic se dvakrát nesčítá ani nedokončuje. Pro pozornost úkolu má **prázdný čtverec jen oranžovou/červenou konturu bez fajfky**, nezávisle na zeleném/modrém/růžovém pozadí skupiny. Návrhy Lumi mohou vizuálně vyčnívat, běžný seznam zůstává klidný.

## Kalendář: na mobilu vždy jeden den a datové bublinky

Mobilní Kalendář nemá přepínač **Den / 3 dny / 7 dní**. **Vždy zobrazuje jediný zvolený den**, ve svislé časové ose; nad ní je jako v původním oblíbeném mockupu **vodorovný proužek datových bublinek**. Každá má **zkratku dne v týdnu nad číslem data** („Po“ nad „3“, „Út“ nad „4“ atd.). **Zvolený den je výrazně fialově zvýrazněný i v minulosti. Nevybrané uplynulé dny jsou tlumeně šedé včetně zkratky dne, čísla data i jemného podkladu**, podobně jako dokončené úkoly, ale **neoznačuje to jejich události za dokončené**. Dnešek a budoucí dny mají výraznější neutrální kontrast; dnešek je srozumitelně odlišen i mimo výběr. Klepnutí na další bublinku přepne jediný den osy, posun proužku umožní další dny a samostatné „Dnes“ rychle vrátí aktuální datum. V žádném mobilním režimu se nezobrazují tři ani sedm paralelních sloupců. Výběr dne zůstává zachovaný při bezpečném návratu na obrazovku, bez přenosu dat mezi identitami.

~~~text
Kalendář                            Dnes   ⋯
   Po     Út     St     Čt     Pá     So     Ne
   (3)     4      5      6      7      8      9
    ↑ minulý zvolený den = fialový, ostatní minulé = šedé

09:00 ────────────────────────────────
10:00  [Standup – Lumi · 10:00–10:30]
11:00 ────────────────────────────────
13:00  [Oběd · 13:00–14:00]
15:30  [Vyzvednout děti · 15:30]
──────────────────────────────────────
Můj plán     Kalendář     Projekty     Více
~~~

Na šířce 390 px jsou názvy a data bublinek čitelné, dotykové cíle alespoň 44 px, řádek lze horizontálně posunout **bez horizontálního posunu celé stránky**; čtečka oznámí celý den, datum a stav vybráno/dnes. Desktopový Kalendář může mít širší vícedenní zobrazení, toto rozhodnutí se týká jen mobilu.

Události mají jemné časové bloky a čitelné názvy. Potvrzená rezervace je výslovně „Rezervováno“; návrh Lumi má hvězdu, jiný akcent a výzvu k posouzení. Skrytá událost zůstává pouze v Kalendáři jako „Skryto“, lze ji obnovit, a její vliv na kapacitu se řídí kalendářovým kontraktem. Odpojený nebo zastaralý kalendář nikdy nepředstírá přesnou kapacitu; nabízí Připojit či Obnovit a uvádí stáří dostupných dat.

## Projekty: pastelové skupiny bez nadpisů, stejné písmo, kruhové stavy

V Projektech je **tentýž globální přepínač rozsahu `Vše / Osobní / Sdílené`**, nikoli vlastní druhý filtr. Při vstupu se zachová volba z ostatních pracovních pohledů; přepnutí zde změní globální rozsah a po návratu zůstane aktivní. **Vše** zobrazuje **všechny projekty, k nimž mám platné oprávnění ke čtení**, tedy všechny vlastní soukromé a všechny autorizované sdílené (včetně projektů bez mých přidělených úkolů). **Osobní** zobrazí pouze mé soukromé projekty, **Sdílené** pouze všechny autorizované projekty ve sdílených Oblastech. **Můj plán** je zvláštní úvodní obrazovka s mými soukromými a mně přidělenými sdílenými úkoly, nikoli synonymum `Vše` v Projektech. Případný filtr konkrétní Oblasti se s rozsahem protíná a nesmí zobrazit více dat, než dovoluje globální rozsah a serverové ACL. Stejně jako Můj plán se projekty seskupují do jemně pastelových bloků podle Oblastí bez viditelných nadpisů prostoru nebo Oblasti. Oblast i typ prostoru jsou přístupné v detailu, pro čtečku a před citlivým zápisem, i když jsou vizuální štítky skryté.

Základní projektový řádek: **kruh + název + kontextové menu**. Název používá přesně stejnou **velikost i tučnost** jako úkol v Mém plánu; **počty úkolů, poměry dokončení a štítky Oblastí nejsou v přehledu vidět**. Nanejvýš jedna stručná věta o aktuálním problému / dalším kroku, je-li věcně užitečná. Kruh je bez vazby na prostor: neutrální prázdný, urgentní pouze oranžově/červeně konturovaný prázdný kruh bez výplně a bez fajfky, hotový šedý s fajfkou. Dokončený název je rovněž tlumený. Pozornost má srozumitelný text i pro screen reader.

Projekt otevře samostatnou stránku: název, stav a případný postup **v detailu**, ihned poté jeho úkoly, až pak volitelné Kontext, Poznámky/Zdroje, Podrobnosti, Historie. Ovladač dokončení projektu vyžaduje serverové oprávnění a **nesmí potichu dokončit otevřené podřízené úkoly**.

## Detail úkolu, Home, Doručené a schvalování

**Úkol:** jediný **čtvercový** checkbox vedle výrazného názvu, kompaktní Kdy / termín / projekt, poznámka nebo checklist a jedno rozbalení sekundárních údajů. Oblast se **v detailu může a při sdíleném zápisu musí** zobrazit textem; v Mém plánu se štítek skrývá jen na řádku. Hotová položka má šedou ikonu i název. Oprávnění, konflikt a selhání uložení mají zřetelný stav.

**Domů / Denní brief** (přístupný z Více či desktopového sidebaru) uvádí nejvýše pět relevantních doporučení, jejich lidský důvod a přístupné „Proč?“ s oprávněným zdrojem a skutečným časem. Kapacita se tvrzením nezpřesňuje, je-li kalendář stale/offline. Výběr doporučení vede na oprávněný detail.

**Doručené** z Více přijímá úkol, poznámku, schůzku, odkaz i vstup z pošty; filtry a originál návrhů zůstávají dostupné, nic se nepotvrzuje samo. **Quick Capture** ukazuje před uložením výchozí **soukromou Nezařazeno** (nebo zděděnou Oblast projektu), sdílení vyžaduje explicitní seznam členů a souhlas. Ruční nízkorizikové „Kdy → zítra“ se provede s Undo, ale **návrh Lumi** vyžaduje explicitní Schválit/Odmítnout, dopad a hodnoty před/po. Při konfliktu a po revokaci nedochází k zakázané změně.

## Akceptační kontrola designu

- 390 px, spodní **čtyři záložky**, žádná spodní záložka Hledat, výchozí obrazovka **Můj plán**, ale jediný globální filtr **Vše / Osobní / Sdílené**. `Vše` v Projektech zobrazuje všechny skutečně autorizované projekty, zatímco Můj plán i při Vše zachovává osobní pracovní výběr.
- Můj plán má jen pastelové **nepojmenované** skupiny Oblastí, žádné per-task štítky, čitelné tmavé názvy; čtečka oznamuje Oblast.
- V každém pohledu je **úkol čtverec**, **projekt kruh**, otevřené bez fajfky, pozornost pouze červenou/oranžovou **konturou bez výplně a bez fajfky**, hotové šedé **s fajfkou**, tlumený název; **žádný „rozpracovaný“ stav**.
- Projekty mají stejné jemné skupinové podbarvení podle Oblastí jako Můj plán, **bez nadpisů prostoru/Oblasti**, počtů či barevných štítků; typografie shodná s úkolem.
- Mobilní kalendář vždy **jeden den**, navigace **řadou bublin se zkratkou dne nad číslem data**, bez 1/3/7 přepínače; **uplynulé nevybrané dny jsou šedé, vybraný den fialový i v minulosti**, bez spojování šedé s dokončením událostí; správná dostupnost, přístupnost a výběr dne. Kalendářová událost není úkol, návrh není potvrzený blok; žádná duplicita v akčním plánu.
- Přístupnost a bezpečnost: kontrast, světlo/tma, zvětšení textu, dotyk/klávesnice/VoiceOver, Back/Forward, deep link, offline a revokace bez úniku obsahu.
- Jde o **cílovou specifikaci**; aktualizace dokumentace neaktivuje serverové Area ACL, nepovoluje produkční reset/cutover a neslouží jako výjimka pro plný Browser E2E během PR.
