# Rodinný archiv dokumentů pro Lumi — zadání a návrh řešení (2026-11-22)

**Stav:** vlastníkem potvrzený produktový směr včetně **etapy 1: nová Airtable base Rodina pro Auto, Dokumenty a Nákupy; Rekonstrukce Světice zůstává samostatná**, následně migrace do Lumi; **návrh technického provedení**, zatím **neimplementováno / nenasazeno**. Tento dokument neaktivuje nový zdroj dat, import skutečných dokumentů, R5 ani žádnou produkční integraci. Technické detaily a zavedení podléhají navazujícímu issue, bezpečnostnímu review a release branám. Navazuje na [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [ROADMAP](../ROADMAP.md), [rodinnou HumanWiki](2026-11-20-humanwiki-personal-family-memory.md) a [sjednocení Airtable](2026-11-22-unified-family-airtable.md).

## 1. Produktový cíl a schválená zjednodušení

Jednoduchý **společný rodinný digitální archiv** smluv, účtenek, záručních listů, návodů, potvrzení, faktur, dokladů k domu, autu apod. Člen rodiny dokument pouze naskenuje nebo nahraje z iPhonu, Macu či PC. Systém sám přečte obsah, vytěží návrh metadat, zařadí jej do evidence a zpřístupní jej Lumi pro citovatelné odpovědi, hledání a případná upozornění.

V první verzi:
- **Žádná nová mobilní aplikace** ani povinné rozhraní pro třídění; na iPhonu se používají nativní **Soubory, skener dokumentů, Sdílet a Zkratky**.
- **Jedna společná evidence**, bez složitých složek, štítkování uživatelem, per-dokumentové „soukromé/zabezpečené“ klasifikace nebo schvalování každého importu. Kontrola jen chyb a nejednoznačností.
- **Příchozí sdílená složka iCloud Drive** jako preferovaný jednoduchý transport odkudkoliv, nikoli jediný trvalý archiv ani záloha. Při implementaci ověřit spolehlivý příjem na cílovém Macu; při nemožnosti zvolit ekvivalentní nativní Zkratku s autorizovaným příjmem na server.
- **Etapa 1 — Airtable Free, dvě oddělené báze:** nová **`Rodina`** sjednotí pouze **Auto, Dokumenty a Nákupy** do tří tabulek `Dokumenty`, `Majetek` a `Události`. Dosavadní **Rekonstrukce Světice zůstane samostatná a beze změny** včetně svých osmi tabulek a vazeb. Rodina má centrální archiv originálů, zpracování/OCR provádí worker, Lumi postupně umí číst oba zdroje. Paperless-ngx není potřeba. Návrh, limity Free a postup migrace: [konsolidace tří bází](2026-11-22-unified-family-airtable.md).
- **Etapa 2 — Lumi:** po ověřeném exportu originálů, metadat a vazeb se archiv **`Rodina`** může přesunout do Lumi (spravovaný file store + SQLite). **Rekonstrukci není potřeba migrovat zároveň**; Lumi ji může nadále číst jako samostatný autorizovaný Airtable zdroj. Zkratky a uživatelský tok se nemění.
- „Otevřený pro rodinu“ **neznamená veřejný na internetu**: přístup mají jen autorizovaní členové domácnosti; základní autentizace, transportní bezpečnost, ochrana před smazáním a zálohy zůstávají.

## 2. Uživatelské scénáře

**A. Papír na iPhonu:** V aplikaci Soubory otevřít sdílené *Rodinný archiv / Příchozí* → *Skenovat dokumenty* → uložit vícestránkové PDF. Alternativou je zástupce/zkratka na ploše, **jen pokud** ji lze spolehlivě sestavit z podporovaných akcí iOS; neslibovat automatické předání výstupu nativního skeneru ze Zkratek bez ověření. Bez ručního zadávání názvu, typu či data.

**B. PDF, fotografie či soubor:** Na iPhonu přes nabídku *Sdílet → Do rodinného archivu* (Zkratka pro uložení do příchozí složky), z Macu/PC přetažením nebo uložením do synchronizované složky. V první etapě se originál po převzetí uloží jako příloha **nového či odpovídajícího záznamu v `Rodina / Dokumenty`**. Nepodporovaný typ se srozumitelně označí; nahrání se nesmí tvářit jako zpracování.

**C. Použití v Lumi:** Např. „Kdy končí pojištění auta?“, „Najdi poslední revizi kotle“, „Kde je návod k vysavači?“. Lumi odpoví výhradně z aktuálně dostupného obsahu, uvede konkrétní dokument, stránku či úryvek a odkaz na otevření originálu. Neznámá/nejistá data nepodává jako fakta.

**D. Výjimka:** Nečitelný sken, neurčitý vlastník, více kandidátů pro přiřazení, konflikt dat nebo chyba importu → položka *Ke kontrole* s minimální jednorázovou opravou. Běžné importy nevyžadují schválení.

## 3. Logický tok

1. **Příjem** (iCloud folder adapter; později volitelně přímý upload): detekovat nový stabilně dosynchronizovaný soubor; nezpracovávat neúplný zápis. Zdokumentovat konektivitu, prodlevu a chyby synchronizace, případně stav „čeká na synchronizaci“.
2. **Bezpečné převzetí v etapě 1:** validovat typ, limity velikosti/stran a čitelnost; worker z příchozího souboru vypočítá SHA-256, přiřadí stabilní `document_id` a přes chráněný serverový Airtable API token uloží originál jako přílohu záznamu v **nové konsolidované Airtable tabulce `Rodina / Dokumenty`**. Potvrdit, že se příloha skutečně v Airtable uchovala (a ideálně přečíst zpět/ověřit hash), dříve než se import označí dokončeným nebo smaže dočasný zdroj. Duplicitní doručení je idempotentní. Neposílat token Airtable do distribuované iOS Zkratky; otestovat omezení přímého attachment uploadu a bezpečnou záložní metodu bez veřejně vystaveného nechráněného dokumentu.
3. **Zpracování:** extrakce textu z PDF/dokumentů, OCR pro skeny/fotografie a volitelná lokální multimodální extrakce. Stavové kroky `received → stored → extracted → classified → indexed` a `needs_review/failed`; opakovatelná bezpečná fronta s diagnostikou.
4. **Metadata:** nabídnout strojově odvozený typ dokumentu, srozumitelný název, datum vystavení, případnou platnost/termín, vystavitele, předmět (člen domácnosti / auto / dům / zařízení / projekt), číslo smlouvy či dokladu a klíčové hodnoty relevantní k typu. Mapovat do **navržených polí nové `Rodina / Dokumenty`** a při migraci zachovat původní pole bez přepisu dříve ručně zadaných hodnot; nové volby v select polích nevytvářet nekontrolovaně. Nevyplňovat neexistující hodnoty odhadem.
5. **Indexace:** přesný text, stránky, metadata a vyhledávací index pro Lumi; odvozený index je obnovitelný. **V etapě 1 jsou kanonické přílohy a metadata v nové Airtable `Rodina`**; lokální OCR text/cache/index slouží jen jako obnovitelný derivát, případně ukládat do Airtable pouze vhodně omezený výtah textu. V etapě 2 se kanonickými stanou originály + SQLite metadata v Lumi. Případné informace o entitách do Context Graphu jen s dohledatelnou proveniencí a odpovídajícím `review` stavem.
6. **Dotazy a upozornění:** Lumi vyhledává přes serverový **PACT Context Resolver** a vydává citace na dokument. U končící platnosti smí nabídnout úkol/připomínku, ale její vytvoření či jiná akce zachovává existující pravidla schválení, audit a Undo. Důležitý termín nelze zaměnit za automaticky potvrzený závazek.
7. **Příchozí soubor neodstranit jen na základě přijetí:** úklid až po potvrzeném trvalém převzetí a ověřené politice záloh; nedovolit, aby iCloud synchronizované smazání zničilo jediný exemplář.

## 4. Etapa 1 — `Rodina` + samostatná `Rekonstrukce Světice` na Airtable Free

Nová `Rodina` sjednotí **pouze tři stávající zdroje**: `Auto / Události`, `Dokumenty / Dokumenty` a `Nákupy / Nákupy`. Čtvrtá base **`Rekonstrukce Světice` zůstává v aktuálním stavu**; není zdrojem pro první migraci, nepřebírají se z ní požadavky, kontroly, etapy, rozhodnutí, zdroje ani přílohy. Přesný datový návrh a migrační pravidla: [Airtable Free — konsolidace tří bází](2026-11-22-unified-family-airtable.md).

**Ověřený snapshot (2026-11-22):**

- `Auto`: **78** záznamů, **45** příloh, přibližně **44,8 MiB**.
- `Dokumenty`: **101** záznamů, **108** příloh, přibližně **73,1 MiB**.
- `Nákupy`: **43** záznamů, **93** příloh, přibližně **52,8 MiB**.
- **Celkem `Rodina` ze zdrojů: 222 záznamů a 246 příloh (170,7 MiB)** před přidáním nových položek pro majetek/přílohy.
- `Rekonstrukce Světice`: **352** záznamů v **8** tabulkách, původní vazby zůstávají a velikost jejích příloh nebyla součástí této inventury.

**Limity Free:** 1 000 záznamů a 1 GB příloh **na base**, 1 000 API volání **na workspace za měsíc**. Rozdělení do dvou bází poskytuje samostatné limity na data a soubory, **nikoli další API kvótu** v témže workspace. Airtable Free nepodporuje skutečné `linked record` mezi oddělenými bázemi ani placené cross-base sync propojení. Lumi případné souvislosti řeší až přes dva samostatně autorizované adaptéry, případně přes explicitní externí odkaz/ID; nepředstírat cross-base `linked records`.

**Nové tři tabulky `Rodina`:**

- `Dokumenty`: originály, OCR, datum, typ, vystavitel, poznámky, stabilní UUID a vazby na majetek či události. Původní jeden záznam s více přílohami je nutné bezpečně namapovat včetně identity všech příloh.
- `Majetek`: vozidla a pořízené věci, prodejce, datum nákupu, záruka v měsících, vypočtené `Záruka do`, vazby na dokumenty/události.
- `Události`: servis, tachometr, datum, stav, kategorie, poznámky, vazba na majetek a dokument.

**Import:** iPhone Soubory/skener či Sdílet/Zkratky → sdílená iCloud `Příchozí` → lokální nebo zabezpečený worker → OCR/metadata → `Rodina / Dokumenty` a volitelné odkazy na `Majetek` či `Události`. Žádný Airtable API token v iPhone Zkratce.

**Migrace:** ověřit API kvótu Free a rezervu pro migraci, vytvořit úplnou zálohu **tří** zdrojových bází včetně binárních příloh (nepoužívat expirované odkazy jako archiv), vytvořit novou base `Rodina`, zkušební import, idempotentní dvouprůchodové mapování záznamů/relací, checksum a počty pro všech 246 snapshot příloh, audit ručních poznámek a záruk, teprve poté řízené přepnutí. Původní tři báze neodstraňovat. **Rekonstrukce Světice zůstává běžně aktivní a není součástí cutoveru.**

## 4a. Etapa 2 — Lumi bez povinné migrace rekonstrukce

Po ověřeném exportu `Rodina` přenést originály do samostatného file store a metadata, stabilní UUID a vztahy do kanonické cílové SQLite Lumi. `Rekonstrukce Světice` může být nadále samostatnou Airtable base a druhým autorizovaným zdrojem pro Lumi; její případná budoucí migrace je **samostatný plán, nikoli podmínka** pro rodinný archiv. Bez paralelní databáze znalostních pravd, bez povinného Paperless-ngx.

Při přechodu zachovat všechny originály, metadata, ruční opravy, vazby a citace, ověřit SHA-256 a obnovitelné zálohy. Nepřepínat zdroj pouze proto, že byl dokončen export; před cutoverem ověřit i stále funkční iPhone Zkratku. Airtable ani originály se nemažou automaticky.

## 5. Přístup a hranice vůči existujícímu Lumi

**MVP může být owner-only.** Současný profil `personal-v1` má jediného vlastníka a soukromé Oblasti. Zamýšlená společná rodinná čtení/zápisy **neobcházejí** identity a Area ACL: zpřístupnění všem členům rodiny přes Lumi až po produkčním R5 (pozvánky, sdílená Oblast, členství, use-time ACL, revokace a testy). Sdílená iCloud *příchozí schránka* může mezitím sloužit členům k podání dokumentu, ale **sama negarantuje víceuživatelský přístup v Lumi ani oprávnění k publikaci odvozených znalostí**. Zajistit, že rodinou předané dokumenty jsou skutečně určeny pro společný archiv; případnou citlivou výjimku řešit mimo tento MVP.

Nezavádět nový veřejně dostupný bezautentizační endpoint, přímý přístup modelu k souborům nebo SQLite, nevynechávat PACT Resolver. Úryvky, názvy, výsledky, počet, náhledy, exporty a cache podléhají efektivním právům aktéra. Integrace s HumanWiki neuděluje souhlas s profilováním členů rodiny ani automatickým zveřejněním osobní preference. **Zvláště dokumenty dětí / třetích osob** nezakládají samy o sobě potvrzený osobní claim.

- Dokumentový import je **samostatný explicitně zapnutý zdroj**. Neobchází H1-real blokaci [#400](https://github.com/Kocooour/AI-executive/issues/400) pro reálný HumanWiki import; tento dokument neautorizuje import Gmail těl, příloh ani plošné prohledávání schránek. Ručně předaný soubor a automatické čtení celé pošty jsou různé souhlasy.
- **Výchozí AI extrakce lokálně**, bez odeslání celé rodinné dokumentace externím modelům. Externí AI až po samostatném výslovném opt-in a kontrolách vhodnosti dat.
- Dokumenty jsou **nedůvěryhodný vstup**: izolované parsování/OCR, omezení zdrojů, ochrana proti zip bombám a path traversal, kontrola škodlivých formátů, žádné vykonávání instrukcí z textu dokumentu (prompt injection).
- **Zálohy a obnova zahrnují originály i SQLite metadata**, kontrolu souladnosti manifestů/checksumů a pravidelně zkoušené obnovy. iCloud není jediná kopie. Export má přenositelný formát, žádné vazby pouze na absolutní cestu serveru.
- Pozdější výmaz a revokace přístupu se promítnou i do indexů a řízených odvozenin dle existujícího bezpečnostního kontraktu; nepředstírat odstranění již stažených kopií.

## 6. MVP, mimo rozsah a podmínky zavedení

**MVP (jediný vertikální scénář):** po ověřeném sjednocení **tří** původních bází do nové `Rodina`, zatímco `Rekonstrukce Světice` zůstává odděleně: iPhone Soubory → nativní sken → iCloud Příchozí → uložení originálu do **`Rodina / Dokumenty`** → OCR/metadata → nalezení v Lumi s citací a otevřením původního PDF z Airtable. Vedle toho otestovat „Sdílet → Do rodinného archivu“ pro PDF a uložení z Macu/PC. Bez vlastní iOS aplikace, bez Paperless, bez nových položek spodní navigace.

**Mimo MVP:** automatický import pošty; plně autonomní zakládání nebo změna úkolů, placení a smluv; per-dokumentová přístupová politika; veřejné sdílení; vlastní webové DMS UI; automatický export do HumanWiki. Lokální AI model i samotný hosting na domácím Macu jsou cílové preference, nikoli předstíraný existující provoz.

**Postup:** (1) read-only inventura a obnovitelná záloha **tří** migrovaných bází, kontrola zbývajícího Free API/storage budgetu; `Rekonstrukce Světice` ponechat beze změny; (2) nová `Rodina` se třemi tabulkami a migračním manifestem; (3) syntetický/vzorkový test a úplný idempotentní import záznamů a 246 snapshot příloh s kontrolou hashů; (4) ověřit iPhone/Zkratky/iCloud a Airtable API limity; (5) importní OCR worker, owner-private čtení v Lumi s citacemi a samostatný read adaptér pro rekonstrukci až podle jejího scope; (6) produkční přepnutí `Rodina` jen po schválení a release branách; (7) později přesun `Rodina` do Lumi bez povinného přenesení rekonstrukce; (8) multi-user sdílení až po R5.

## 7. Akceptační scénáře (budoucí end-to-end)

| ID | Ověření |
|---|---|
| DOC-01 | Sken vícestránkového papíru v nativních Souborech se bez mobilní aplikace objeví jako dohledatelný dokument s otevřitelným originálem. |
| DOC-02 | Z nabídky Sdílet na iPhonu a ze souboru na Macu/PC lze přidat PDF bez ručního zadávání metadat. |
| DOC-03 | OCR českého dokumentu rozpozná text, ale nečitelný údaj nezíská falešnou jistotu; výjimka je dohledatelná k ruční opravě. |
| DOC-04 | Duplikované doručení, restart pracovníka, opožděná synchronizace a částečný soubor nezpůsobí ztrátu ani zdvojení kanonického záznamu. |
| DOC-05 | Lumi odpoví se zdrojovým dokumentem, stránkou a odkazem; neexistující nebo neplatný termín nepředstírá jako fakt. |
| DOC-06 | Přerušený import, chyba OCR i výpadek iCloud mají viditelný stav; přečtení chybného dokumentu nemůže provést tool-call nebo změnu dat. |
| DOC-07 | Po obnově/exportu Airtable i budoucí Lumi jsou originály a metadata konzistentní, index lze znovu sestavit; smazání příchozího zdroje neodstraní archivovanou kopii. |
| DOC-08 | Není veřejný přístup; před R5 neumí cizí aktér získat obsah přes API, hledání, Context Resolver, náhled ani citaci. Po R5 mají přístup pouze členové autorizované společné Oblasti. |
| DOC-09 | Manuálně opravené metadata zůstanou zachovány po opakované extrakci; novější a zrušená verze dokumentu se rozlišují. |
| DOC-10 | Bez zvláštního opt-in nejde dokumentový obsah do externí AI, automatického e-mailového importu ani do profilů HumanWiki. |
| DOC-11 | Nový import přidá do **nové `Rodina / Dokumenty`** dokument a binární přílohu; stávající záznamy, výběrové hodnoty a poznámky čtyř původních bází nezmění. Mobilní Zkratka neobsahuje Airtable API token. |
| DOC-12 | Lumi otevře aktuální přílohu i po expiraci dřívější Airtable download URL, bezpečně obnoví autorizovaný přístup; výpadek API přizná místo smyšleného odkazu. |
| DOC-13 | Export ze **tří** migrovaných bází, konsolidace do `Rodina` a pozdější přenos do Lumi zachová každý záznam, přílohu a vazbu uvnitř `Rodina` (počty + SHA-256), UUID, metadata i ruční opravy; opakování je idempotentní. Původní rekonstrukce zůstává beze změny. |
| DOC-14 | Po kontrolovaném přepnutí z Airtable do Lumi funguje stejná iPhone Zkratka a stejná uživatelská otázka/citace; žádná původní příloha se nemaže bez výslovného rozhodnutí. |

**Rozhodnutí ponechaná implementaci:** schválení návrhu nové `Rodina` base na Free (pouze tři zdroje), API budget a stav samostatné `Rekonstrukce Světice`, kompatibilita iCloud synchronizace na konkrétním hostu, typy polí/vztahů v nové Airtable struktuře, attachment API limity a typy, OCR engine a lokální model po benchmarku, provozní frekvence importu, pravidla úklidu příchozí složky, plán migrace. Žádné z těchto rozhodnutí nesmí změnit uživatelskou jednoduchost ani bezpečnostní hranice bez review.
