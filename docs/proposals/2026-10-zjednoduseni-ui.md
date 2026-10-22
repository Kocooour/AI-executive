# Návrh: zjednodušení UI a revize logiky Lumi

> **Stav: návrh k rozhodnutí vlastníka, nic z toho není implementováno.** Vychází ze stavu `main` k 22. 10. 2026 (po PR #91), z [PRODUCT.md](../PRODUCT.md), [UX-UI.md](../UX-UI.md), [ARCHITECTURE.md](../ARCHITECTURE.md) a [MAIL-CONNECTORS.md](../MAIL-CONNECTORS.md). Body označené **⚑ rozhodnutí** mění dosavadní kontrakt a před implementací vyžadují souhlas vlastníka (AGENTS.md → Scope control).

Revize proběhla na produkčním buildu se syntetickými daty (3 projekty, 2 oblasti, 11 úkolů, 1 poznámka) na desktopu 1440 × 900 a na iPhonu 390 × 844.

---

## 1. Shrnutí

Lumi má silný základ: kanonický model, workspaces, attention s důvody, plán dne, schvalování s Undo, Gmail jen pro čtení. Uživatel ale vidí **stejné úkoly třikrát až čtyřikrát na jedné obrazovce**, metadata a zdůvodnění má u každé položky rozbalená a dvakrát klikne tam, kde by stačilo jednou. Z UI je cítit, jak se postupně stavěl (B2, B3, B4…), ne jak se v něm pracuje.

Navrhuji tři principy a pět změn:

| Princip | Co znamená v UI |
|---|---|
| **Jedno místo pro jednu věc** | Úkol se na obrazovce objeví jednou. Plán dne je pohled na seznam Dnes, ne druhý seznam. |
| **Akce u objektu, vysvětlení na vyžádání** | Řádek nese datum, které jde rovnou změnit. Proč, zdroj a čerstvost jsou o klik dál. Nic z toho nemizí, jen to není rozbalené. |
| **Lumi navrhuje jedním tlačítkem** | Každý návrh Lumi je konkrétní věta s jedním tlačítkem „Použít“ a s Undo. Hromadná schvalovací obrazovka jen tam, kde se mění víc věcí najednou. |

| # | Změna | Rozsah | Rozhodnutí |
|---|---|---|---|
| A | Odložení úkolu ve stylu Things (kalendář v řádku + návrh Lumi) | UI + lehká logika | ne |
| B | Kontext projektu (proč je důležitý, hlavní cíle, hotovo když) a stránka projektu | UI + datový model | drobné ⚑ |
| C | Lumi z e-mailů navrhne nový projekt s kroky | logika + konektor + UI | **⚑ ano** |
| D | Zjednodušení navigace, Domů, Dnes a detailu úkolu | UI | ne |
| E | Opravy logiky nalezené při revizi | logika | ne |

Doporučené pořadí dodání: **E → A → D → B → C** (od nejmenšího rizika, každé jako samostatné PR, viz §8).

---

## 2. Co jsem v aplikaci našel

### 2.1 Navigace
- Sidebar má 9 hlavních položek, pod nimi „Další pohledy“ (Po termínu, Kdykoli, Někdy, Hotové, Kontext, Agenti) a Nastavení. Dalších 6 pohledů je schovaných, ale Oblasti, Poznámky a Hledání jsou nahoře, přestože hledání je i v topbaru (⌘K).
- Počty u Projektů (3), Oblastí (2) a Poznámek (1) jen opakují počet položek a nic neříkají o pozornosti.
- **Pošta je schovaná v Nastavení → Pošta.** Číst e-maily a z nich vytvářet úkoly je pracovní činnost, ne nastavení.
- Na mobilu je spodní lišta Domů / Doručené / Dnes / Kalendář / Více. Projekty jsou až ve „Více“, přestože jsou podle UX-UI.md P0 (Project detail).

### 2.2 Domů
- Každá položka pozornosti má větu důvodu, zdroj dat, „vyhodnoceno 22. 10. 08:07“ a rozbalovací „Zdroje“. U čtyř položek se stejný čas vyhodnocení opakuje čtyřikrát.
- Na mobilu má každá položka čtyři ovladače (Odložit o 24 h, Skrýt, Otevřít, Zdroje), takže první obrazovka ukáže jen dvě až tři položky a plovoucí ＋ zakrývá „Otevřít“.
- Pod pozorností následuje sekce Dnes se stejnými úkoly a pod ní text „Pro spolehlivé časové bloky připojte kalendář“ a „Úkoly bez časového bloku: 6“, jenže sekce Dnes ukazuje 4 úkoly.

### 2.3 Dnes
Jedna obrazovka ukazuje tytéž úkoly třikrát:
1. karta „Lumi · právě teď: Žádný úkol právě neběží“ (velká karta bez akce, když nic neběží),
2. „Plán dne Lumi“: 6 karet, každá s „Bez vhodného bloku“, odhadem, rozbalovacím „Proč právě teď“ a třemi tlačítky (Jiný čas, Zítra, Neplánovat). To je 18 tlačítek pro 6 úkolů,
3. klasický seznam Dnes (4 úkoly) s filtry Priorita a Řazení.

Plán obsahuje i úkoly, které v seznamu Dnes nejsou (blížící se termín), takže čísla 6 a 4 vedle sebe působí jako chyba.

### 2.4 Detail úkolu (inspektor)
Pod sebou je 15 polí: Kontext (počty „úkoly: 2 · poznámky: 0 · projekty: 1 · oblasti: 1“), „Co Lumi ví: zatím žádná tvrzení“, Seznam (select), Kdy (Dnes/Zítra/Někdy/Bez data + date input), termín, Projekt, Oblast, Priorita, Čekání, Odhad, Navržený čas, Připomínka, Poznámky, Kontrolní seznam, Opakování, a nakonec Přesunout na Někdy / Spustit / Dokončit / Smazat.
- „Seznam“ a „Kdy“ vyjadřují totéž dvakrát (Doručené/Dnes/Kdykoli/Někdy vs. Dnes/Zítra/Někdy/Bez data) a mohou si odporovat.
- Prázdné bloky (Kontext s nulami, „žádná tvrzení“) zabírají první obrazovku inspektoru.
- Odložení = najít pole Kdy, kliknout do date inputu a vybrat den. Žádné „příští týden“, „o víkendu“.

### 2.5 Projekty
- Seznam projektů ukazuje jen název a počet úkolů. Chybí cíl, další krok, stav a riziko, takže se nedá říct, kterému projektu se věnovat.
- Projekt se otevírá v pravém inspektoru vedle seznamu projektů, ne jako vlastní stránka. Úkoly projektu jsou až pod přehledem, kontextem a poli.
- Pole „Cíl / výsledek“ je jediný textový popis projektu. Chybí *proč* je projekt důležitý a hlavní cíle. Text „Lumi ho bez schválení nedoplňuje“ je správný, jenže Lumi ho nedoplňuje ani se schválením, protože k tomu nemá žádnou cestu.

### 2.6 Kalendář
- Bez připojeného kalendáře opakuje obrazovka „Kalendář není připojen“ třikrát a pod tím ukazuje seznam úkolů bez nadpisu, takže není jasné, proč tam je.

### 2.7 Pošta
- Gmail v2/v3 umí otevřít zprávu a vlákno a vědomě z nich vytvořit úkol (do Doručených, s `mailSource`). [MAIL-CONNECTORS.md](../MAIL-CONNECTORS.md) výslovně vylučuje **AI zpracování e-mailů, LLM přenos a automatické vytváření úkolů**. Požadavek C proto mění kontrakt (§6).

---

## 3. Změna A: odložení úkolu ve stylu Things

### 3.1 Interakce
Na každém řádku úkolu (Dnes, Nadcházející, Doručené, projekt, Domů) je vpravo **datový čip**: „Dnes“, „Zítra“, „Po 27. 10.“, nebo jen ikona kalendáře, když úkol datum nemá. Klik na čip (nebo klávesa `D` na vybraném řádku, na mobilu klepnutí) otevře popover **Kdy**:

```
┌ Kdy ──────────────────────────────────────┐
│ ✦ Lumi: Přesunout na pondělí 26. 10.       │
│   Tento týden máte 3 úkoly s termínem      │
│   a tenhle žádný nemá.      [Použít]       │
├───────────────────────────────────────────┤
│ ★ Dnes          ☾ Dnes večer               │
│ → Zítra         ▣ Tento víkend             │
│ ⇥ Příští týden  ☁ Někdy                    │
│ ┌ říjen 2026 ───────────────────────────┐  │
│ │ Po Út St Čt Pá So Ne                  │  │
│ │ …  mini-kalendář, klik = datum        │  │
│ └───────────────────────────────────────┘  │
│ Termín: 30. 10. (nemění se)   ✕ Bez data   │
└───────────────────────────────────────────┘
```

- Jeden klik na volbu **okamžitě uloží** `when` a zavře popover. Pod seznamem se objeví toast „Přesunuto na zítra · Zpět“ (Undo stejnou cestou jako dnes).
- „Příští týden“ = pondělí příštího týdne (podle `timezone` vlastníka; nastavitelný začátek týdne až později), „Tento víkend“ = nejbližší sobota, „Dnes večer“ = `when` dnes + `properties.evening = true` (nová skupina v Dnes, jako v Things).
- Popover vždy ukazuje **termín (deadline) jen pro čtení**. Odložení nikdy nemění termín, a když vybrané datum termín přesahuje, volba je označená „po termínu 30. 10.“ a vyžaduje druhé potvrzení.
- Totéž menu je v kontextovém menu řádku, v hromadném výběru (Doručené B5) a v detailu úkolu, kde nahradí dvojici „Seznam“ + „Kdy“ (§5.4).
- Mobil: popover se otevře jako spodní sheet, volby mají ≥ 44 px, návrh Lumi je nahoře.

### 3.2 Návrh Lumi na jedno tlačítko
Nahoře v popoveru je **nejvýše jeden** návrh: věta s důvodem a tlačítko **Použít**. Návrh je deterministický a vysvětlitelný (PRODUCT.md: model nesmí vymýšlet ani tajně řadit). V první verzi stačí pravidla a model může větu jen přeformulovat.

| Situace (vyhodnocuje se v pořadí) | Návrh | Důvod, který Lumi ukáže |
|---|---|---|
| Úkol má termín do 48 h | **Nenavrhuje odklad**, ale „Nechat na dnes“ | „Termín je zítra; odklad by ho ohrozil.“ |
| Dnes je přetíženo: součet odhadů úkolů na dnes > volná kapacita (jen s čerstvým kalendářem), nebo > 6 úkolů na dnes bez kalendáře | Nejbližší den s volnou kapacitou před termínem | „Dnes máte 7 úkolů a 2 h volna; ve čtvrtek je volno.“ |
| Úkol bez termínu a s nízkou/žádnou prioritou, tento týden ≥ 3 úkoly s termínem nebo vysokou prioritou | Pondělí příštího týdne | „Tento týden mají přednost 3 úkoly s termínem; tenhle termín nemá.“ |
| Úkol byl odložen ≥ 3× (viz §3.3) | **Někdy** nebo „Rozdělit na menší krok“ (otevře detail) | „Odkládáte ho potřetí. Chcete ho dát do Někdy?“ |
| Úkol čeká na někoho (`waiting`) s `followUpDate` | Den follow-upu | „Čekáte na Petra; připomenu se v den follow-upu.“ |
| Jinak | Zítra | „Nejbližší volný den.“ |

- Návrh se počítá klientsky z kanonických dat, která už v Dexie jsou (úkoly, termíny, priority, odhady, `dayPlan` a stav kalendáře). Žádné nové API a žádný model nejsou nutné. Logika patří do `lib/defer-suggestion.ts` jako čistá funkce s unit testy (pevný čas a pásmo Europe/Prague).
- Kalendářová kapacita se použije, jen když je kalendář čerstvý. Jinak Lumi o volném čase nic netvrdí (PRODUCT.md, Calendar-aware planning).
- Klik na **Použít** je vědomá akce vlastníka nad viditelnou konkrétní změnou (datum před → po). Jde o běžnou lokální editaci s Undo, ne o PACT proposal. Proposal + approval zůstává pro změny, které připraví chat nebo agent bez přímého kliknutí.

### 3.3 Data
- Beze změny schématu: `properties.when` (YYYY-MM-DD), `properties.someday`, `properties.today`, `properties.inbox`. Nově `properties.evening?: boolean`.
- Nově `properties.deferHistory?: Array<{ from: string | null; to: string | null; at: number; via: "manual" | "lumi" }>` (posledních 10 záznamů). Slouží pro pravidlo „odloženo ≥ 3×“ a pro učení plánu (`day-plan-learning.ts` už `planningFeedback` sbírá, tohle je jeho doplněk pro odklady mimo plán dne).
- Attention: přesun `when` je nový výskyt `planned_date_passed` (PRODUCT.md, rozhodnutí 2026-10-09), takže odložení položku pozornosti korektně vyřeší a nevznikne duplicita.

### 3.4 Akceptační kritéria
1. Z řádku v Dnes se úkol přesune na „Příští týden“ dvěma kliky, zmizí z Dnes, objeví se v Nadcházející pod pondělím a Undo ho vrátí.
2. Úkol s termínem zítra nikdy nedostane návrh odkladu. Volba data po termínu vyžaduje potvrzení a termín se nezmění.
3. Bez čerstvého kalendáře návrh netvrdí nic o volném čase.
4. Popover je ovladatelný klávesnicí (šipky, Enter, Esc) a VoiceOverem. Na mobilu je to sheet bez gest.
5. Offline se odklad uloží lokálně s viditelným stavem čekání na synchronizaci.

---

## 4. Změna B: kontext projektu a stránka projektu

### 4.1 Obsah kontextu
Každý projekt dostane krátký slovní kontext, viditelný jako hlavička projektu a jako první řádek v seznamu projektů:

```
Nový web firmy                                   ● Aktivní · 3/7 kroků
──────────────────────────────────────────────────────────────────────
Proč je důležitý
  Současný web neprodává a brzdí nábor; nový web je podmínkou
  listopadové kampaně.
Hlavní cíle
  • Spustit nový web do 30. 11.
  • Udržet SEO pozice (migrace bez ztráty návštěvnosti)
  • Texty a grafika schválené Janou
Hotovo, když
  Nový web běží na produkční doméně a kampaň na něj vede.
                                        [Upravit] [✦ Lumi navrhne]
```

- **Proč je důležitý**: 1–3 věty. **Hlavní cíle**: 1–5 odrážek. **Hotovo, když**: 1 věta (dnešní pole „Cíl / výsledek“ se do něj převede beze ztráty).
- V seznamu projektů je pod názvem první věta „Proč“, vpravo průběh (hotové/všechny kroky), další krok a jeden attention štítek (např. „bez dalšího kroku“, „3 po termínu“). Seznam pak ukazuje, kam sáhnout.

### 4.2 Kdo kontext píše
- Primárně vlastník: inline editace s viditelným stavem ukládání (stejný vzor jako dnešní `ProjectOverview`).
- **✦ Lumi navrhne**: Lumi z názvu, úkolů, poznámek projektu a navázaných e-mailových zdrojů (pokud je C schváleno) připraví **koncept**. Ukáže se jako diff (před → po) v běžném approval sheetu a uloží se až po potvrzení. U kontextu je pak štítek „navrženo Lumi, potvrzeno 22. 10.“. Neodporuje to textu „Lumi ho bez schválení nedoplňuje“, jen pro to přidává schválenou cestu. **⚑ drobné rozhodnutí:** souhlasíte, aby Lumi kontext projektu navrhovala (přes PACT proposal, nikdy přímo)?
- Kontext je pro chat a plánování **owner statement** s provenance (Context Graph). Odklad podle §3.2 i řazení plánu ho mohou použít jako potvrzenou důležitost projektu.

### 4.3 Data
```ts
properties.context = {
  why: string,            // "Proč je důležitý"
  goals: string[],        // "Hlavní cíle", max 5
  doneWhen: string,       // dříve properties.goal
  provenance: "owner" | "lumi-approved",
  proposalId?: string,    // u lumi-approved: odkaz na audit
  updatedAt: number,
}
```
Migrace v `schema-migrations.ts`: `properties.goal` → `context.doneWhen` a `goal` ponechat pro zpětnou kompatibilitu (čtení) jednu verzi. Zálohy a export: pole je součást entity, takže se nic dalšího neřeší. Sdílený workspace: kontext vidí jen členové daného workspace (beze změny pravidel).

### 4.4 Stránka projektu
Projekt se otevře jako **hlavní pohled** (jako v Things), ne v inspektoru vedle seznamu projektů:
1. hlavička: název, stav, průběh, kontext (§4.1),
2. **úkoly projektu s nadpisy sekcí** (Things „headings“, nové `properties.heading` na úkolu nebo entita `heading`; může přijít později),
3. poznámky a zdroje (e-maily, schůzky),
4. sbalená sekce „Podrobnosti“: oblast, termín projektu, poslední aktivita, „Co Lumi ví“ (claims), historie.

Inspektor vpravo slouží jen pro detail úkolu otevřeného ze stránky projektu. **Oblasti** přestanou být samostatná hlavní položka a v seznamu projektů se z nich stanou skupiny (Práce, Domov, Bez oblasti), stejně jako v Things. Pohled Oblasti zůstane dostupný přes „Další pohledy“.

### 4.5 Akceptační kritéria
1. Nový projekt má po založení prázdný kontext s nápovědou. Seznam projektů bez kontextu ukáže „Doplňte, proč je projekt důležitý“, ne prázdné místo.
2. Návrh Lumi se nikdy neuloží bez potvrzení. Potvrzení se dá vrátit Undo a je v auditu.
3. Starý `goal` je po migraci vidět jako „Hotovo, když“ a nic se neztratí. Zálohu před migrací jde obnovit.
4. V „Vše moje práce“ je kontext jen pro čtení (dnešní pravidlo).

---

## 5. Změna D: zjednodušení navigace, Domů, Dnes a detailu

### 5.1 Navigace
Desktop sidebar: **Domů · Doručené · Dnes · Nadcházející · Projekty · Kalendář** a pod čarou seznam aktivních projektů (jako v Things, max. 7, s průběhem). Dál:
- **Poznámky a Hledání** zůstanou dostupné přes ⌘K a přes „Další pohledy“. Hledání v topbaru už existuje. *(Odchylka od UX-UI.md IA, kde jsou Notes a Search v primárním sidebaru: **⚑ potvrďte**, případně ponechme Poznámky.)*
- **Pošta** se přesune z Nastavení do Doručených jako záložka/filtr „Z pošty“ (seznam vláken z připojených účtů, otevření, „Vytvořit úkol“, později „Navrhnout projekt“). Nastavení → Pošta zůstane jen pro připojení účtu.
- Počty v sidebaru jen tam, kde vyjadřují práci: Doručené (k roztřídění), Dnes (otevřené dnes). U Projektů místo počtu červená tečka, když některý projekt potřebuje pozornost.
- Mobil: spodní lišta **Domů · Doručené · Dnes · Projekty · Více**. Kalendář se přesune do „Více“ a na Dnes (pás událostí nahoře, viz §5.3). *(⚑ potvrďte, UX-UI.md má Calendar v bottom nav.)*

### 5.2 Domů
- Položka pozornosti má jeden řádek titulku a jeden řádek důvodu („Termín byl včera“). Vpravo je jedna primární akce podle typu položky: u termínu **datový čip** (stejný popover jako §3), u čekání „Připomenout“, u projektu bez kroku „Přidat krok“. Odložit/Skrýt/Zdroje jsou v menu `⋯`. Na mobilu je swipe jako zkratka, ne jediná cesta.
- „Vyhodnoceno 22. 10. 08:07“ jen jednou v hlavičce sekce („Aktualizováno 8:07 · Obnovit“). Detail zdrojů a čerstvosti zůstává v rozbalení položky a v „Pokrytí a čerstvost“.
- Sekce Dnes na Domů ukáže **jen úkoly, které nejsou v pozornosti** (bez duplicit), max. 5, plus „Zobrazit vše“.
- Nepřipojený kalendář = jedna nenápadná věta v patičce, ne tři.

### 5.3 Dnes
Jeden seznam místo tří vrstev:
```
Dnes                                   čt 22. 10. · 4 úkoly · ~3 h
[ pás událostí z kalendáře, jen když je připojen ]
▸ Běží: Napsat inzerát  12 min   [Pauza] [Hotovo]   ← jen když něco běží
──────────────────────────────────────
○ Schválit grafický návrh homepage     09:00–09:30   Dnes ▾
○ Napsat inzerát                        —            Dnes ▾
○ Vybrat obklady        plánováno na 19. 10.          19. 10. ▾
Dnes večer
○ Koupit dárek mámě                                  Večer ▾
──────────────────────────────────────
✦ Lumi: Na dnes je to ~1 h přes kapacitu. Přesunout „Vybrat obklady“
  na pondělí?                                     [Použít] [Jiný návrh]
```
- Plán dne se stane **sloupcem času** v řádku (navržený blok šedě, přijatý plně) a jedním souhrnným návrhem Lumi dole. Tlačítka Přijmout/Jiný čas/Zítra/Neplánovat přejdou do popoveru času/data na řádku.
- „Proč právě teď“ je tooltip/rozbalení řádku, ne blok u každé karty.
- Karta „Žádný úkol právě neběží“ se nezobrazuje, když nic neběží.
- Úkoly s blížícím se termínem, které nejsou na dnes, se v Dnes neukazují. Jsou na Domů v pozornosti. Počty pak sedí.
- Filtry Priorita/Řazení přejdou do menu `⋯` v hlavičce.

### 5.4 Detail úkolu
```
○ Zkontrolovat SEO migraci                                    ⋯
[📅 25. 10. ▾] [⚑ Termín —] [▣ Nový web firmy ▾] [! Priorita ▾]
Poznámky…
☐ Kontrolní seznam…
▸ Další: odhad · připomínka · opakování · čekání · navržený čas
▸ Kontext a zdroje (jen když nějaké jsou)
──────────────────────────────────────
[Spustit]                               [Dokončit]   (Smazat v ⋯)
```
- „Seznam“ zmizí. Doručené = `inbox`, jinak rozhoduje Kdy (Dnes / datum / Kdykoli = bez data / Někdy). To je model Things a odstraní rozpor dvou selectů.
- Oblast se dědí z projektu a zobrazí se, jen když úkol nemá projekt.
- Prázdný „Kontext“ (samé nuly) a „Co Lumi ví: žádná tvrzení“ se nezobrazují. Když něco existuje, je to sbalená sekce s počtem.
- Smazat je v menu `⋯`, ne vedle Dokončit.

### 5.5 Co se neztratí
Všechny dnešní funkce zůstávají: filtry Po termínu, Kdykoli, Někdy, Hotové (Další pohledy), Context review, Agenti, hromadné třídění B5, mobilní triage B4, approval/Undo, plán dne s přijetím bloku, workspaces a „Vše moje práce“. Mění se umístění a výchozí rozbalení, ne schopnosti. E2E testy se upraví tak, aby dál ověřovaly stejné chování, jen s novými selektory (AGENTS.md: neoslabovat testy).

---

## 6. Změna C: Lumi z e-mailů navrhne nový projekt s kroky ⚑

### 6.1 Proč je to rozhodnutí
[MAIL-CONNECTORS.md](../MAIL-CONNECTORS.md) dnes říká: *žádné AI zpracování, žádný LLM přenos, žádné automatické vytváření úkolů, žádná synchronizace na pozadí.* Analýza e-mailů modelem tento kontrakt mění. Navrhuji to udělat ve dvou krocích, aby se dal každý schválit zvlášť:

| Varianta | Co Lumi čte | Kdy | Riziko | Doporučení |
|---|---|---|---|---|
| **C1: na vyžádání** | jedno vlákno, které vlastník otevře a klikne „✦ Navrhnout projekt“ | jen po kliknutí | nízké: vědomý přenos jednoho vlákna, stejné jako dnešní „Vytvořit úkol“ | **začít tímto** |
| **C2: průběžná analýza** | metadata + texty nových zpráv v Inboxu za posledních N dní | plánovač, max. 1× denně | vyšší: obsah pošty pravidelně jde modelu, potřebuje retenci a privacy gate (PRODUCT.md fáze 4) | až po C1 a samostatném schválení |

Obě varianty: **nic se nevytvoří bez potvrzení**. Výstupem je vždy návrh v Doručených. Text e-mailu se neukládá (ukládají se jen ID zdroje jako dnes v `mailSource`). Model dostane jen nezbytný výřez (předmět, odesílatelé, text bez příloh, max. ~8 000 znaků). U poskytovatele se respektuje `AI_PROVIDER` (Hermes lokálně / OpenAI). Při vypnutém modelu tlačítko vysvětlí, že návrh není dostupný.

### 6.2 Tok (C1)
1. Doručené → Z pošty → vlákno „Re: Nabídka na nový e-shop“ → **✦ Navrhnout projekt**.
2. Lumi nejdřív porovná s existujícími projekty (název, kontext, účastníci). Při shodě nabídne: „Vypadá to jako projekt *Nový web firmy*. Přidat kroky tam?“ a jako druhou volbu nový projekt.
3. Návrhová karta (editovatelná):
   ```
   ✦ Návrh projektu z e-mailu (Jana Nováková, 3 zprávy, 20.–22. 10.)
   Název:  Nový e-shop
   Proč:   Klient chce spustit prodej online před Vánoci; nabídka platí do 31. 10.
   Cíle:   • Odsouhlasit nabídku  • Spustit e-shop do 15. 12.
   Kroky:  ☑ Odpovědět Janě na rozsah            Zítra
           ☑ Připravit cenovou nabídku            Termín 31. 10.
           ☑ Domluvit call s klientem              Příští týden
           ☐ Objednat hosting                      —
   Oblast: Práce     Workspace: Osobní
                        [Zahodit]   [Upravit]   [Založit projekt (3 kroky)]
   ```
4. **Založit projekt** = jeden PACT proposal nového druhu `create_project_bundle` (projekt + kontext + vybrané úkoly + relace + `mailSource` na projektu i úkolech), proveden atomicky s auditem a Undo (Undo smaže jen to, co vzniklo, a jen pokud to nikdo mezitím neupravil). Využívá existující `ai-actions.ts` (create/update/project). Přibude jen druh operace s více entitami.
5. Kroky dostanou datum podle pravidel z §3.2 (nikdy za termínem z e-mailu, termíny z e-mailu jsou návrh, ne potvrzený fakt) a štítek „z e-mailu“ s odkazem na zdroj.

### 6.3 Kontrakt modelu
- Vstup: výřez vlákna + seznam názvů a kontextů existujících projektů v témže workspace (kvůli deduplikaci). Nic z jiného workspace.
- Výstup: striktní JSON (`title`, `why`, `goals[]`, `doneWhen`, `steps[{title, when?, deadline?, evidence}]`, `matchProjectId?`), validovaný serverem. Každý krok musí mít `evidence` = citaci z e-mailu, jinak se zahodí. Data se parsují deterministicky (`local-dates.ts`), ne modelem.
- Citlivé/confidential zdroje se modelu nepošlou (dnešní pravidla citlivosti).

### 6.4 Akceptační kritéria
1. Bez kliknutí vlastníka se žádný e-mail modelu neodešle (C1). Test to ověří na mocku Gmailu a poskytovatele.
2. Zahození návrhu nic nevytvoří. Potvrzení vytvoří přesně vybrané kroky v jednom workspace. Druhé potvrzení téhož návrhu skončí konfliktem bez duplicit.
3. Krok bez citace z e-mailu se nenavrhne. Navržený termín je označen jako „z e-mailu, ověřte“.
4. Odpojený účet nebo vypnutý model = srozumitelná hláška, žádný částečný stav.

---

## 7. Změna E: opravy logiky nalezené při revizi

| # | Problém | Kde | Dopad | Oprava |
|---|---|---|---|---|
| E1 | `taskDueSummary` míchá **plánovaný den (`when`)** s **termínem (`deadline`)**. Úkol naplánovaný na dnes ukazuje „Termín se blíží“, prošlý plánovaný den ukazuje červeně „Po termínu“. | `app/ui/format.ts:62` | Falešná naléhavost v rozporu s PRODUCT.md (`deadline_overdue` vs. `planned_date_passed`) | Rozlišit: termín → „Termín zítra / Po termínu“, plán → „Plánováno na 19. 10.“ (neutrální barva). Unit test. |
| E2 | Plán dne říká u úkolu bez termínu „Po termínu“ | `dayPlanReason_overdue` / `day-plan.ts` | dtto | Stejný rozdíl jako E1 v důvodech plánu |
| E3 | Štítky v Domů → Dnes jsou „Termín Se Blíží“ (CSS `text-transform: capitalize`) | `app/globals.css` (`.homeTaskList small`, `.contextItems small`) | Vzhled | Odstranit capitalize |
| E4 | „Úkoly bez časového bloku: 6“ vedle seznamu Dnes se 4 úkoly | Home + day plan | Nedůvěra v čísla | Plán dne počítá jen úkoly v Dnes, případně říká „6 včetně 2 s blížícím se termínem“ |
| E5 | Projekt se otevírá v inspektoru, úkoly projektu jsou až pod přehledem | `detail-panel.tsx` | Projekt nejde rozumně spravovat | §4.4 |
| E6 | Pole „Seznam“ a „Kdy“ v detailu mohou odporovat (např. Seznam = Někdy, Kdy = 25. 10.) | `detail-panel.tsx` | Úkol na dvou místech nebo nikde | §5.4: jeden model `inbox` + `when`/`someday` |
| E7 | Pošta jen v Nastavení | `settings-view.tsx` | Funkce se nepoužívá | §5.1 |
| E8 | Kalendář bez připojení ukazuje nepopsaný seznam úkolů | `calendar-view.tsx` | Nejasné | Nadpis „Úkoly bez času“ nebo odkaz do Dnes |

E1–E4 jsou malé a bezpečné opravy. Doporučuji je jako první PR, protože nepotřebují žádné produktové rozhodnutí.

---

## 8. Plán dodání

Každý řádek = jedno PR s vlastní větví a worktree podle [DEVELOPMENT.md](../DEVELOPMENT.md), s plným `Browser E2E` a se dvěma nezávislými testery podle AGENTS.md.

| PR | Obsah | Závislost | Nové/upravené testy |
|---|---|---|---|
| 1 | E1–E4, E8: oddělení plánu a termínu, štítky, počty | – | unit `format`/`day-plan`, e2e home/today |
| 2 | A: `lib/defer-suggestion.ts` + popover Kdy na řádku, Undo, `deferHistory`, `evening` | 1 | unit pravidel (pevný čas), e2e odkladu desktop + mobil + offline |
| 3 | D1: navigace (sidebar, mobilní lišta, Pošta do Doručených) | ⚑ potvrzení IA | e2e design-navigation, mobile-more |
| 4 | D2: Dnes jako jeden seznam s časovým sloupcem, Domů bez duplicit | 2 | e2e mobile-today, home-quiet, day plan |
| 5 | D3: detail úkolu (čipy, sbalené sekce, zrušení „Seznam“) | 2 | e2e detail-inspector, task-row |
| 6 | B: `context` projektu, migrace `goal`, stránka projektu, skupiny podle oblastí | ⚑ B | unit migrace, e2e project-overview, backup-restore |
| 7 | B+: „✦ Lumi navrhne“ kontext přes proposal | 6 | e2e approval/Undo |
| 8 | C1: „✦ Navrhnout projekt“ z vlákna, `create_project_bundle` | ⚑ C, 6 | unit validace výstupu, e2e s Gmail + AI mockem, data-boundary |
| 9 | C2: průběžná analýza | ⚑ C2, 8 | privacy/retence, plánovač, dedup |

---

## 9. Otázky pro vlastníka

1. **C (pošta → model):** Souhlasíte se změnou MAIL-CONNECTORS na variantu **C1** (jedno vlákno, jen po kliknutí)? Kterého poskytovatele použít pro obsah e-mailů: jen lokální Hermes, nebo i OpenAI?
2. **B:** Smí Lumi navrhovat text kontextu projektu (vždy přes schválení)?
3. **Navigace:** Souhlasíte s přesunem Poznámek a Hledání z hlavního sidebaru do ⌘K / Dalších pohledů a s Projekty místo Kalendáře ve spodní liště mobilu?
4. **Odklad:** Má „Příští týden“ znamenat pondělí, nebo chcete volitelný den (např. neděli pro týdenní review)? Chcete skupinu „Dnes večer“?
5. Mám začít PR 1 (opravy E1–E4, bez produktového rozhodnutí) hned?
