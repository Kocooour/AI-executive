# Jednotná rodinná databáze v Airtable — návrh konsolidace (2026-11-22)

**Status:** návrh nové struktury na základě výslovného cíle vlastníka sjednotit současné databáze **Auto, Dokumenty, Nákupy a Rekonstrukce Světice**. Byla provedena **pouze read-only inventura schémat a agregovaných počtů**. Nová base, tabulky, data, přílohy ani automatizace **zatím nebyly vytvořeny ani změněny**. Návrh podléhá review a následnému samostatnému migračnímu kroku. Souvisí s [rodinným archivem dokumentů](2026-11-22-family-document-archive.md), [PRODUCT](../PRODUCT.md) a [architekturou Lumi](../ARCHITECTURE.md).

## 1. Rozhodnutí a cíl

V etapě 1 nebude kanonická evidence v původní samostatné Airtable base `Dokumenty`, ale ve **zcela nové společné Airtable base `Rodina`**. Tam se konsolidují záznamy všech čtyř původních bází včetně binárních příloh, specifických polí a existujících vztahů. Původní čtyři báze se při migraci **nesmažou**, dokud není ověřena úplnost a provoz nové evidence. Přidávání dokumentů z iPhonu zůstane bez vlastní aplikace: Soubory/skener a Sdílet/Zkratky → iCloud Drive příchozí → ingest worker → centrální `Dokumenty` v Airtable → Lumi pro autorizované dotazy.

V etapě 2 lze stejnou logickou strukturu **beze změny rodinného workflow** převést do kanonického úložiště Lumi (originály ve file store, metadata v cílovém SQLite, index jako obnovitelný derivát). Nová Airtable struktura proto musí mít stabilní, přenosná ID a explicitní vztahy.

**Nezaměňovat:** jedna *Airtable base* neznamená jednu tabulku; doménové záznamy se propojují přes `linked records`, nikoli kopírováním příloh nebo textu na mnoho míst. Jedna společná dokumentová evidence není povolení vydat všechny existující osobní údaje každému; multi-user přístup přes Lumi nadále čeká na R5.

## 2. Ověřená výchozí struktura

| Zdroj | Současná tabulka / oblast | Podstatné informace k zachování |
|---|---|---|
| Auto | `Události` | Datum, výběr auta, stav, tachometr, poznámky, kategorie, servis, přílohy |
| Dokumenty | `Dokumenty` | Datum, kdo, instituce, kategorie, důvod, typ dokumentu, poznámky, originály v přílohách |
| Nákupy | `Nákupy` | Předmět, foto, datum nákupu, záruka v měsících, účtenka, prodejce, vypočtené `Záruka do`, manuály, původní složka |
| Rekonstrukce Světice | `Požadavky` | Kritéria, priorita, lokalita, stav ve studii/DSP/realizaci, citace a návaznosti |
| Rekonstrukce Světice | `Kontroly`, `Otevřené body`, `Etapy`, `Zdroje` | Skutečné Airtable linked-record vazby k požadavkům; nesmí se ztratit |
| Rekonstrukce Světice | `Rozhodnutí`, `Rozpočet`, `Starší náměty` | Rozhodnutí, cenové intervaly, původní neuplatněné návrhy |

Zdroj má celkem **11 tabulek**. Při inventuře bylo v původních třech evidencích zjištěno několik typů příloh (dokumenty, fotografie, účtenky, manuály). Aktuální stav dat a počet příloh se **musí znovu načíst při migračním exportu**, protože se mohou měnit. Do repozitáře nepatří skutečný obsah záznamů, jména rodiny, hodnoty citlivých polí, download URL ani Airtable API identifikátory a tokeny.

## 3. Navrhované tabulky v nové base `Rodina`

| Nová tabulka | Účel | Zdroj |
|---|---|---|
| **Dokumenty** | Jediný katalog dokumentů včetně originálních souborů, OCR, typu, data, subjektu, instituce, platnosti a zdroje | `Dokumenty` + přílohy z `Auto` a `Nákupy`, časem i projektové podklady |
| **Majetek** | Vozidla, zakoupené výrobky a případně nemovitosti; datum koupě, prodejce, délka/končení záruky, sériové ID, vazby na dokumenty | `Nákupy` + hodnoty pole `Auto` v `Události` |
| **Události** | Servisy, opravy, kontroly a další životní události majetku; datum, stav, tachometr (pro vozidla), servis a přílohy přes odkaz na `Dokumenty` | `Auto / Události` |
| **Projekty** | Nadřazený kontext; první projekt Rekonstrukce Světice, v budoucnu další | Nový referenční záznam bez duplicitní kopie všech podkladů |
| **Požadavky** | Zadání, kritéria, priority, fáze a zdroje rekonstrukce | `Rekonstrukce / Požadavky` |
| **Kontroly** | Jednotlivé ověření požadavků ve studii, DSP a realizaci | `Rekonstrukce / Kontroly` |
| **Otevřené body** | Rozpory a nevyjasněné otázky | `Rekonstrukce / Otevřené body` |
| **Etapy** | Etapizace, rozsah, závislosti | `Rekonstrukce / Etapy` |
| **Zdroje** | Evidované projektové podklady a odkazy na e-maily; postupně link na `Dokumenty`, pokud existuje archivovaný originál | `Rekonstrukce / Zdroje` |
| **Rozhodnutí** | Schválené a navržené projektové záměry s původem | `Rekonstrukce / Rozhodnutí` |
| **Rozpočet** | Práce/kapitoly, spodní a horní odhad, etapa | `Rekonstrukce / Rozpočet` |
| **Starší náměty** | Read-only historické podněty, které se nemají zaměnit za aktivní požadavek | `Rekonstrukce / Starší náměty` |

**Celkem 12 tabulek** v první konzervativní migraci: 4 společné jádrové a 8 dosavadních projektových. Osm tabulek rekonstrukce se záměrně předčasně neslučuje, aby nezmizely významové rozdíly a její již fungující kontrolní matice. `Starší náměty` lze zjednodušit až po pozdějším rozhodnutí; historické záznamy se nesmějí automaticky stát aktivními úkoly.

### Vztahy místo duplicit

- `Majetek ↔ Dokumenty`: účtenky, záruky, manuály, smlouvy, fotografie.
- `Majetek ↔ Události ↔ Dokumenty`: vozidlo / servisní zásah / příloha.
- `Projekty ↔ Požadavky ↔ Kontroly`: požadavek a průběžná kontrola v různých fázích.
- `Požadavky ↔ Otevřené body / Etapy / Zdroje`: **zachovat skutečné existující `linked records`**, žádné pouhé textové kopie názvu.
- `Projekty ↔ Rozhodnutí / Rozpočet / Etapy`, `Zdroje ↔ Dokumenty` (jen pokud se podaří bezpečně dohledat odpovídající originál).
- `Dokumenty` mohou odkazovat na více příbuzných objektů, projektů nebo událostí. Nemají obsahovat kopii téhož PDF u každé vazby.

## 4. Struktura `Dokumenty` a `Majetek`

**Dokumenty:** srozumitelný `Název` (primární pole), `Typ`, `Datum dokumentu`, `Instituce/vystavitel`, `Kdo/subjekt`, `Kategorie`, `Důvod` (stávající význam neautomaticky neměnit), `Poznámky`, `Soubor(y)` (Airtable attachments), `OCR výtah` / stav OCR, `Platnost do`, `Ke kontrole`, vztahy k Majetku, Událostem a Projektům a stabilní UUID/provenance. Pole OCR má velikostní limity; úplný výsledek lze držet jako obnovitelný index mimo Airtable, dokud probíhá etapa 1. Když jeden původní záznam obsahuje více originálů, zachovat jeho skupinu a u každé přílohy zvlášť identitu, checksum a zdrojové umístění v exportním manifestu.

**Majetek:** `Název`, `Druh` (vozidlo/výrobek/nemovitost), `Datum koupě`, `Záruka [měsíce]`, `Záruka do` (**vzorec ze dvou původních polí**, s ověřením data a nulových hodnot), `Prodejce`, identifikační údaje (jen podle potřeby), původní `Složka` jako legacy pole, vazby na `Dokumenty` a `Události`. Původní `Nákupy` tak zůstanou evidencí pořízených věcí, nikoli nákupním seznamem. Výběrové hodnoty automobilů se převedou na objekty/auta v Majetku, pokud jsou skutečně používané; bez deduplikace vozidel podle podobného názvu.

**Události:** `Datum`, `Majetek`, `Typ/kategorie`, `Stav`, `Tachometr`, `Servis`, `Poznámky`, `Dokumenty`. Typově nesouvisející údaje (tachometr u běžného výrobku) zůstanou prázdné.

**Projekty:** `Název`, `Stav`, `Poznámka`, stabilní ID, vazba na domácnost/objekt a příslušné požadavky, etapy, rozpočet, zdroje.

**U všech migrovaných záznamů:** skryté technické atributy nebo samostatný bezpečně ukládaný mapovací manifest pro `uuid`, `source_base`, `source_table`, `source_record_id`, `source_field`, `source_attachment_id`, checksum, čas/verzi exportu a stav převzetí. Původní `ID`/autonumber se zachová jako `Původní ID`; nové Airtable record ID ani autonumber nejsou trvalé identifikátory budoucí Lumi. Nespoléhat na krátkodobá attachment download URL jako na trvalé odkazy.

## 5. Postup migrace bez výpadku a ztráty

1. **Read-only inventura a kontrolní manifest**: uložit mimo veřejný repozitář verzi všech zdrojových schémat, vzorců, select options, záznamů, skutečné mapy linked-record vazeb, příloh, view/automations, přístupových práv a referencí do jiných služeb. Přepočítat počty v čase exportu.
2. **Záloha zdrojů**: úplný výpis všech záznamů s originálními Airtable ID a daty, **binární stažení každé přílohy pomocí aktuálního autentizovaného odkazu**, individuální SHA-256/velikost a kontrolní manifest; vyzkoušet čtení zálohy. Samotný CSV export ani seznam attachment URL není úplnou zálohou.
3. **Vytvoření nové base `Rodina`** ve správném Airtable workspace s 12 tabulkami, definovanými typy polí a obousměrnými linky. Novou base vytvořit bez kopírování tajemství a bez úprav původních čtyř bází. Ověřit správné primární pole u každé tabulky a vazby podle schématu.
4. **Testovací import** syntetických a malého ověřeného vzorku záznamů; žádné tiché přejmenování hodnot, změna měny či interpretace neznámých polí. Nahrát originály do centrální `Dokumenty` a zpětně ověřit jejich existenci. Při přenosu příloh postupovat podle skutečně podporovaných Airtable attachment API a velikostních limitů.
5. **Dvouprůchodový import**: (a) vytvořit řádky se stabilními UUID a mapou source → target IDs, (b) až potom propojit `linked records` (zejména Požadavky ↔ Kontroly/Otevřené body/Etapy/Zdroje), a přílohy/zdrojové citace. Opakované spuštění musí bezpečně doplnit chybějící, nikoli zdvojit existující.
6. **Rekonsiliace**: porovnat počty zdrojových a cílových řádků **po tabulkách**, počty a checksumy souborů, důležité prázdné hodnoty, záruky/odvozená data, počet oboustranných vazeb, volby/filtry, vzorce, výstupy rekonstrukční matice a náhodně vybrané konkrétní záznamy. Všechny nesrovnalosti explicitně evidovat a vyřešit.
7. **Cutover**: při krátkém odstavném nebo řízeném delta-sync okně znovu zpracovat změny; přesměrovat iPhone Zkratku/worker/Lumi na **jedinou kanonickou `Rodina`**. Původní zdroje ponechat dočasně read-only, oznámit jasně, která base je autoritativní. Žádné dual-write bez transakčně řízeného konfliktového protokolu.
8. **Obnova a rollback**: otestovat vrácení na předchozí zdroj i obnovu z manifestu, později navázat na vlastní Lumi file store/SQLite import. Staré báze a přílohy **nemažeme automaticky**, ani po úspěšném importu.

## 6. Fáze a uživatelský kontrakt

**Fáze A — konsolidace Airtable:** nová `Rodina` přebere 4 zdroje. Uživatelské pohledy oddělit pro Dokumenty, Majetek (vozidla a nákupy), Události, Rekonstrukce, ale data žijí ve stejné base a lze je propojovat. Rodina může stále použít původně schválené nativní nahrávání iOS; v této etapě se implementuje bezpečný upload přílohy do centrálních Dokumentů, OCR a návrhy metadat.

**Fáze B — Lumi nad Airtable:** serverový read adaptér a Context Resolver vracejí oprávněné záznamy, metadata a aktuální odkaz na originál. Neprovozovat automatické rozšiřování osobních profilů v HumanWiki. Již připojené rodinné sdílení nedovozovat ze sdílení Airtable workspace; R5 pravidla zůstávají zachována.

**Fáze C — Lumi jako kanonické úložiště:** po úspěšném exportu, kontrole příloh a revizí převezme záznamy/vztahy Lumi; Airtable se stane dočasným read-only archivem. Nativní iPhone workflow ani uživatelské dotazy se nezmění.

### Ochranné hranice

Rodinná base je určena pro společnou evidenci, ale **nemá být veřejně sdílená**, rodinný přístup vyžaduje účty/role. Importovaná historická data mohou obsahovat citlivé informace; automaticky je **nepublikovat širšímu okruhu**, než měly původně. Až bude vlastník explicitně chtít společný multi-user přístup v Lumi, podléhá R5 identitám, Area ACL a zvláštním omezením již existující HumanWiki specifikace. API tokeny a binární zálohy jsou v soukromých serverových konfiguračních/backup lokacích, ne v Zkratkách či veřejném GitHubu.

## 7. Akceptační scénáře

| ID | Podmínka splnění |
|---|---|
| UNI-01 | Všechny čtyři zdrojové báze mají ověřený export a kontrolní manifest; zdroje zůstaly nezměněné. |
| UNI-02 | Nová `Rodina` obsahuje požadované počty záznamů ze všech 11 zdrojových tabulek (se zdokumentovaným mapováním do 12 cílových), bez ztráty nebo zdvojení. |
| UNI-03 | Každá původní příloha má binárně ověřenou kopii v novém úložišti a checksum, včetně samostatných kategorií foto/účtenka/manuál a příloh událostí. |
| UNI-04 | Všechny původní linked-record vztahy rekonstrukce jsou obnovené, existující kontrolní matice dává stejný obsah jako před migrací. |
| UNI-05 | Záruky v měsících a výpočet `Záruka do` odpovídají zdroji; ruční poznámky, původní ID, datum a ostatní důležitá pole zachována. |
| UNI-06 | Jeden dokument se dá propojit s majetkem, servisní událostí a projektem bez duplikování fyzické přílohy. |
| UNI-07 | Duplicitní import a přerušená migrace jsou idempotentní; pozdější změna má řízený delta/cutover a bez schválení nikdy nemaže zdroj. |
| UNI-08 | Uživatel může z iPhonu nativně přidat dokument bez nové aplikace; vznikne v nové `Rodina/Dokumenty` a Lumi jej po autorizovaném ingestu dokáže citovat. |
| UNI-09 | Při nedostupnosti Airtable/attachmentu nevznikne falešně úspěšný import ani neplatný trvalý URL; chybu lze bezpečně opravit. |
| UNI-10 | Pozdější přechod na Lumi zachová UUID, originály, vazby a ruční opravy, stejnou iPhone Zkratku i výsledné odpovědi se zdrojovými citacemi. |

**Další rozhodnutí až před implementací:** konkrétní práva k vytvoření nové base, kompatibilita stávajících integrací/automatizací, mapování více souborů na jeden logický dokument, preferovaná podoba Airtable rozhraní, technika importu příloh, pravidla přístupu rodinných účtů a migrační/rollback okno. 
