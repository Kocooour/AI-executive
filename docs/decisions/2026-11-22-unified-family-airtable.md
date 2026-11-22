# Rodinná evidence v Airtable Free — konsolidace tří bází (2026-11-22)

**Status:** aktualizovaný návrh podle rozhodnutí vlastníka: **sjednotit Auto, Dokumenty a Nákupy do nové base `Rodina`; Rekonstrukci Světice ponechat odděleně**. Zpracována read-only inventura schémat, agregovaných počtů a metadat příloh. **Nevytváří se žádná base, nekopírují se dokumenty a nemění se žádná produkční data.** Cíl: jednoduché nativní nahrávání dokumentů na iPhonu, současná evidence v Airtable a pozdější přenos do Lumi.

Související kontrakty: [rodinný archiv dokumentů](2026-11-22-family-document-archive.md), [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md). Konkrétní názvy souborů, osobní údaje, Airtable interní ID a attachment URL se **nesmějí** ukládat do veřejného repozitáře.

## 1. Rozdělení na dvě Airtable báze

| Airtable base | Obsah | Postup |
|---|---|---|
| **Rodina** (nová) | `Auto` + `Dokumenty` + `Nákupy` | Jedna propojená evidence pro rodinný majetek, servisní události a dokumenty |
| **Rekonstrukce Světice** (stávající) | Všech 8 původních tabulek projektu | **Bez migrace a zásahu do existujících dat, linked records, výpočtů a workflow** |

Rekonstrukce není povinnou součástí nové base, její oddělení je dlouhodobě platné řešení, nikoli dočasná chyba návrhu. Lumi může v budoucnu číst obě báze **oddělenými autorizovanými read adaptéry** a uživateli nabídnout sjednocené vyhledávání při respektování přístupových oprávnění. **Airtable Free neumí nativní `linked records` napříč bázemi**; vazby do rekonstrukce proto nevytvářet jako neexistující cross-base link. Případná reference může být ověřený URL odkaz nebo stabilní externí ID, které interpretuje až Lumi; nesynchronizovat kopii celé rekonstrukční tabulky do `Rodina`. Cross-base Airtable Sync funkcionalita je mimo Free.

### Limity Airtable Free — ověřeno 2026-11-22

Podle oficiálního Airtable: **1 000 záznamů na base (součet tabulek), 1 GB příloh na base, 1 000 API volání na workspace za měsíc, maximálně 5 požadavků za sekundu na base**. Tedy oddělením rekonstrukce získáme samostatný datový a přílohový limit pro každou z obou bází, ale **nikoliv další API rozpočet, pokud jsou ve stejném workspace**. Free má navíc **100 běhů automatizací na workspace měsíčně** a akce **Run a script není dostupná**; OCR a klasifikace proto musí probíhat mimo Airtable (externí worker), ne v Airtable skriptech/na jeden dokument spouštěné automatizaci. Free omezuje spolupracovníky s právy **Owner/Creator/Editor na nejvýše 5 v rámci workspace**; před zpřístupněním celé rodině ověřit aktuální počet účtů a nepoužívat pro zápis sdílený společný login.

- [Airtable — Workspace settings, limity](https://support.airtable.com/articles/9157745778-Airtable-workspace-settings-overview)
- [Airtable — API limit management](https://support.airtable.com/articles/7735693959-Managing-API-call-limits-in-Airtable)
- [Airtable — automation limits](https://support.airtable.com/articles/3669392397-Getting-started-with-Airtable-automations)
- [Airtable — collaborator limits](https://support.airtable.com/articles/1636857517-How-Airtable-collaborators-impact-billing)
- [Airtable — attachment API upload limits](https://support.airtable.com/articles/1744327578-Using-Omni-AI-in-Airtable)
- [Airtable — Getting started with sync](https://support.airtable.com/articles/2849803278-Getting-started-with-Airtable-sync) (neexistuje přímý link mezi bázemi)
- [Airtable — Linking records across synced bases](https://support.airtable.com/articles/3175509073-Linking-records-across-synced-bases-in-Airtable) (Team+)

### Ověřený výchozí stav

| Zdrojová base / tabulka | Záznamů | Počet příloh | Součet velikostí |
|---|---:|---:|---:|
| `Auto / Události` | 78 | 45 | 44,8 MiB |
| `Dokumenty / Dokumenty` | 101 | 108 | 73,1 MiB |
| `Nákupy / Nákupy` | 43 | 93 (foto + účtenky + manuály) | 52,8 MiB |
| **Rodina — tři migrované zdroje** | **222** | **246** | **170,7 MiB** |
| `Rekonstrukce Světice` — 8 tabulek | **352** | **nebylo inventarizováno** | **nebylo inventarizováno** |

Počty jsou snapshot, nikoliv trvalá kapacita. U `Rodina` přibydou nové záznamy pro položky majetku, auta a dokumenty převzaté z příloh událostí/nákupů; cílový počet tedy **nebude automaticky 222**. Přesto je značná rezerva pod 1 000 záznamy. Velikosti souborů jsou součtem dostupných `size` metadat 246 příloh, **ne potvrzená fakturace storage**; zohlednit budoucí nové soubory i případné duplikáty při převodu. Kapacitu celé existující `Rekonstrukce Světice` nutno zkontrolovat samostatně, nikoliv dovozovat z počtu záznamů. **Zjištěno minimálně 3 přílohy nad 5 MB** (v původních Dokumentech a Nákupy), které nelze nahrát běžným přímým Airtable **Upload Attachment API** bez alternativní metody. Přímý upload v tomto API má limit **5 MB na soubor**; vysoký limit běžného attachment pole nelze zaměňovat s limitem upload endpointu.

**Speciální omezení:** 1 000 API volání na workspace/měsíc může být kritičtější než počet záznamů. Dát přednost dávkovým čtením a zápisům (Web API typicky max. 10 záznamů na batch), minimalizaci polling intervalu, lokálnímu OCR před odesláním, krátkým cache a auditovanému rozpočtu API volání; plánovat jednorázovou migraci s rezervou pro obnovu a opravy. Ve Workspace settings ověřit **skutečnou volnou kvótu** před startem; čtení schématu/metadata API také kvótu spotřebovává. Po dosažení kvóty 429 selhat čitelně, ne tiše ztratit import; navázat po obnově kvóty. Nekoncipovat periodické oboustranné synchronizace na vysoké frekvenci a **nespoléhat na Airtable automations nebo Run a script pro OCR**.

## 2. Jednoduchá struktura nové base `Rodina`

**Tři základní tabulky**, oddělené podle významu, propojené Airtable `linked records` **uvnitř stejné base**:

| Tabulka | Hlavní smysl | Zdroje |
|---|---|---|
| **Dokumenty** | Originální přílohy, typ, datum, vydavatel, subjekt, OCR výtah/stav, případná platnost, provenience a zdrojové citace | `Dokumenty / Dokumenty`, přílohy z `Auto / Události`, `Nákupy / Nákupy` |
| **Majetek** | Auta, zakoupené věci a zařízení, datum koupě, prodejce, záruka, vazby na dokumenty a servis | `Nákupy / Nákupy` + hodnoty pole `Auto` ze servisních událostí |
| **Události** | Servisní záznamy, opravy a události majetku, datum, stav, tachometr, kategorie, servis, poznámky a související dokumenty | `Auto / Události` |

Žádná povinná tabulka `Projekty` ani kopie osmi tabulek rekonstrukce. Případný odkaz na nezávislý projekt je pouze URL/externí ID; projektový kontext pro sjednocené vyhledávání může dodat Lumi po ověření přístupu. Zabraňuje se zbytečným počtům záznamů a složitosti.

### Pole a mapování

**Dokumenty**: primární `Název` (lidsky čitelný, pro staré záznamy bezpečně vytvořený), `Druh`/typ, `Datum dokumentu`, `Kdo`, `Instituce`, `Kategorie`, `Důvod`, `Poznámky` (zachovat ručně upravený text), `Soubor(y)` (attachment), `OCR výtah` a jeho stav, `Platnost do`, `Ke kontrole`, stabilní UUID a odkazy na Majetek/Události. Staré záznamy s více přílohami zůstanou seskupeny, identita každé přílohy a její checksum je v manifestu. Základní Dokumenty mohou mít více připojených logických zdrojů, ale jedna fyzická příloha se bez potřeby nekopíruje opakovaně.

**Majetek**: `Název`, `Druh` (auto / pořízená věc / zařízení), `Datum nákupu`, `Prodejce`, `Záruka` (měsíce), `Záruka do` (zachovat původní logiku Airtable `DATEADD(Datum nákupu, Záruka, 'month')`), volitelně původní číselná `Složka`, odkaz na dokumenty a události. Existující hodnoty `Auto` se normalizují na samostatné položky Majetku, ale **nesmí** se neověřeně spojovat dva automobily kvůli podobnému názvu.

**Události**: `Datum`, odkaz na `Majetek`, `Stav`, `Tachometr`, `Servis`, `Kategorie`, `Poznámky`, odkaz na `Dokumenty`. Nevytvářet prázdné nebo umělé hodnoty při přenosu.

**Povinná strategie pro přílohy > 5 MB:** pro každou migrovanou i nově přidanou přílohu vyhodnotit velikost **před pokusem o upload**. Do 5 MB lze využít ověřený přímý Airtable Upload Attachment API; pro větší originály zvolit otestovaný způsob, jímž Airtable načte soubor z **krátkodobého, náhodného, HTTPS podepsaného URL** vydaného z kontrolovaného úložiště, nebo pro výjimku bezpečné ruční nahrání do Airtable. U migrace ze starého Airtable může takový zdrojový odkaz vycházet z právě získaného expirovaného download URL. Nikdy nezveřejňovat dokumenty na neomezeně přístupné URL, nikdy neužívat staré expirující URL jako trvalou referenci, nikdy automaticky nesnižovat kvalitu/velikost originálu ani jej neodmazat před ověřením binární shody (SHA-256). Pokud nelze soubor bezpečně přenést, **zařadit do fronty jako `needs_review` a zablokovat úplné dokončení migrace**, ne ztratit jej nebo falešně potvrdit. Upload metodiku, dostupnost podepsaných URL pro Airtable a limit testovat před plným importem.

**U všech tabulek**: skrytá technická pole nebo zabezpečený manifest pro stabilní `uuid`, původní source base/table/record ID, příslušná stará field/attachment ID, hash, čas importu, stav ověření a opravy; související UUID používá budoucí Lumi. Starý autonumber je **`Původní ID`**, nikoliv primární migrační klíč. Cílové Airtable record ID je technické a může se při migraci do Lumi změnit.

## 3. Vztahy a zpětná kompatibilita

- `Majetek ↔ Dokumenty`: účtenky, fotografie, manuály a smlouvy vztahující se ke konkrétní věci.
- `Majetek ↔ Události ↔ Dokumenty`: historie vozidla nebo zařízení a příslušné servisní dokumenty.
- `Rekonstrukce Světice`: původní vazby `Požadavky ↔ Kontroly / Otevřené body / Etapy / Zdroje`, etapy, rozhodnutí, rozpočet a historické náměty zůstávají v existující base **beze změny**.
- `Rodina ↔ Rekonstrukce`: **žádný Airtable linked-record**, žádná povinná Airtable Sync funkce. Potřebuje-li Lumi společný kontext, zkontroluje oprávněné zdroje v obou bázích a odkaz uvede jako externí zdroj, nikoliv interní vazbu.
- `Rodina / Dokumenty` je vstup pro nové nativní skeny a soubory; projektové podklady v `Rekonstrukce / Zdroje` nezmizí ani se nepovažují za duplikáty bez ověřené shody.

## 4. Bezpečná migrace tří zdrojů a limity Free

1. **Inventura** všech polí, hodnot, vzorců, existujících view/automatizací a celkového počtu souborů; samostatná read-only kontrola využití a možných externích integrací v `Rekonstrukce Světice`, bez změn.
2. **Obnovitelný export originálních tří bází**: všech záznamů, zdrojových hodnot a **binárních příloh** s SHA-256, velikostmi, časem a lokální mapou zdrojových Airtable ID. Běžné CSV s krátkodobými download URL není záloha souborů.
3. **Předběžný kapacitní a API rozpočet** pro novou `Rodina`: očekávaný počet nových objektů (včetně 246 příloh) + rezerva pro nové dokumenty, zkontrolovat součet dat oproti 1 GB a plán API operací proti 1 000 za workspace/měsíc. Případná duplicitní příloha nebo nedostatek API kvóty **zastavuje**, nesmí vést ke ztrátě původního souboru.
4. **Vytvořit novou base `Rodina` v přístupu jen pro vlastníka** se třemi tabulkami a bezpečnými obousměrnými linky; nedotknout se `Rekonstrukce Světice`. **Před udělením rodinného přístupu** prohlédnout reálné složení starých dokumentů a výslovně potvrdit, že celý přenesený soubor dat lze zpřístupnit stejné skupině; záznamy, které takto sdílet nelze, zůstávají mimo společnou base. MVP nevyžaduje per-dokumentové ACL, ale nesmí automaticky rozšířit dosavadní přístup.
5. **Syntetický test + malý vzorek**: otestovat import dokumentů a příloh **pod i nad 5 MB**, zachování binární shody a přístupu bez trvalého veřejného URL, poznámek, `Záruka do`, identity vozidel, obnovu a znovuzískání aktuálních attachment URL.
6. **Dvouprůchodový import**: nejprve cílové záznamy a migrace příloh s manifestem, potom relace podle `source → target UUID`; opakování je idempotentní.
7. **Rekonsiliace** původních tří tabulek: jejich zdrojové počty, každý přenesený binární soubor/velikost/hash, ruční poznámky, vzorce a relevantní select hodnoty; všechny rozdíly zaznamenat před cutoverem.
8. **Cutover a rollback**: doplnit změny vzniklé během importu nebo dočasně zastavit zápisy do tří zdrojů; teprve po ověření přeorientovat ingest/Zkratky/Lumi na **`Rodina`**, původní tři báze prozatím ponechat read-only. **Rekonstrukce Světice zůstane aktivní a na stejné adrese.** Bez automatického mazání či resetu původních bází.

## 5. Uživatelské používání a pozdější Lumi

**Fáze A — Airtable:** nová `Rodina` (Dokumenty, Majetek, Události) + beze změny aktivní `Rekonstrukce Světice`. Rodina si nadále vystačí s nativním iPhone skenem a Zkratkami, podání dokumentu přes iCloud Příchozí. Worker provede OCR, navrhne metadata a uloží dokument do Airtable. Běžná interakce je bez ručního třídění.

**Fáze B — Lumi jako čtecí vrstva:** Lumi v mezích identity/ACL pracuje se dvěma zdroji: `Rodina` a `Rekonstrukce Světice`; dotazy a citace mohou spojit informace z obou bází, aniž by Airtable uměl jejich záznamy přímo propojit. PACT Context Resolver vrací pouze aktuálně autorizovaný výřez. Výpadek/API quota je explicitně označen jako neúplné čtení.

**Fáze C — Lumi jako kanonický archiv:** migrace `Rodina` a **samostatně, pokud bude rozhodnuto, i rekonstrukce**. Nevyžadovat současný cutover obou zdrojů. Nová Lumi spravuje originály, metadata, UUID a vazby; Airtable se postupně odpojuje. Historické zdroje nikdy neodstraňovat jen kvůli dokončenému exportu.

**Bezpečnost:** veřejná GitHub dokumentace neobsahuje citlivé údaje, API tokeny ani binární přílohy. iCloud slouží jako příchozí schránka, ne záloha. API token není v mobilní Zkratce. Externí AI nad obsahem je default-off; rodinný přístup přes Lumi je vázaný na budoucí R5 a zdrojové autorizace, nikoli na fakt, že Airtable má společné pojmenování. Soukromé historické dokumenty se nesmějí bez souhlasu automaticky publikovat.

## 6. Akceptace

| ID | Ověřitelný scénář |
|---|---|
| UNI-01 | Ověřený export/záloha všech tří zdrojových bází včetně binárních příloh; stávající `Rekonstrukce Světice` zůstává beze změny. Nová base při importu zůstává owner-only; případné rozšíření rodinného přístupu vyžaduje vědomé potvrzení sdíleného rozsahu historických dokumentů. |
| UNI-02 | Nová `Rodina` se 3 tabulkami zachovává všech 222 původních záznamů přes stabilní mapování a případné nově potřebné objekty majetku/dokumentů se přidávají transparentně, bez duplikátů. |
| UNI-03 | Každá ze 246 snapshot příloh (počet v čase cutoveru ověřit znovu), včetně nejméně tří nad 5 MB, má v cíli **binárně ověřený originál se SHA-256**; přenos nad limitem přímého upload endpointu používá zabezpečenou alternativu, ne neomezené veřejné URL, kompresi nebo ztrátu souboru. |
| UNI-04 | Existujících 8 tabulek rekonstrukce a všechny původní `linked records` mají totožný stav před i po migračním cutoveru tří jiných bází. |
| UNI-05 | Původní výpočet `Záruka do` a ruční poznámky byly zachovány, cizí/nedoložená data se nedoplňují odhadem. |
| UNI-06 | Dokument/účtenku lze propojit s majetkem a událostí v rámci `Rodina` bez duplicitního fyzického PDF. |
| UNI-07 | Systém bezpečně hlídá 1 000 záznamů a 1 GB příloh na base a sdílenou měsíční kvótu 1 000 API volání ve workspace; limity jsou ověřeny před migrací, 429 vede k dohledatelnému čekajícímu importu. OCR neběží jako Airtable Run a script ani jako neudržitelná per-document Airtable automatizace (Free: 100 běhů/měsíc). |
| UNI-08 | iPhone bez další aplikace uloží sken → worker zpracuje → `Rodina / Dokumenty` jej bezpečně zpřístupní → Lumi jej umí citovat. |
| UNI-09 | Lumi umí přečíst autorizovaná data z oddělené `Rekonstrukce Světice` bez Airtable cross-base syncu/linku; neodhalí cizí data a při nedostupnosti oznámí omezení. |
| UNI-10 | Pozdější přechod na Lumi zachová soubory/metadata/UUID/vazby a nevyžaduje předčasnou migraci rekonstrukce ani změnu iOS Zkratky. |

**Otevřená implementační rozhodnutí:** přesné limity workspace, mechanismus podpory Mac/iCloud příchozí složky, Airtable API budget monitoring, duplicity příloh a jejich kanonická identita, role členů v Airtable, forma orientačních externích odkazů do rekonstrukce a migrační/rollback okno. Rozhodnutí nemají být přijímána automaticky na základě názvů tabulek.
