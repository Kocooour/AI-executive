# Rodinný archiv dokumentů pro Lumi — zadání a návrh řešení (2026-11-22)

**Stav:** vlastníkem potvrzený produktový směr včetně **etapy 1: nová konsolidovaná Airtable base Rodina**, následně migrace do Lumi; **návrh technického provedení**, zatím **neimplementováno / nenasazeno**. Tento dokument neaktivuje nový zdroj dat, import skutečných dokumentů, R5 ani žádnou produkční integraci. Technické detaily a zavedení podléhají navazujícímu issue, bezpečnostnímu review a release branám. Navazuje na [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [ROADMAP](../ROADMAP.md), [rodinnou HumanWiki](2026-11-20-humanwiki-personal-family-memory.md) a [sjednocení Airtable](2026-11-22-unified-family-airtable.md).

## 1. Produktový cíl a schválená zjednodušení

Jednoduchý **společný rodinný digitální archiv** smluv, účtenek, záručních listů, návodů, potvrzení, faktur, dokladů k domu, autu apod. Člen rodiny dokument pouze naskenuje nebo nahraje z iPhonu, Macu či PC. Systém sám přečte obsah, vytěží návrh metadat, zařadí jej do evidence a zpřístupní jej Lumi pro citovatelné odpovědi, hledání a případná upozornění.

V první verzi:
- **Žádná nová mobilní aplikace** ani povinné rozhraní pro třídění; na iPhonu se používají nativní **Soubory, skener dokumentů, Sdílet a Zkratky**.
- **Jedna společná evidence**, bez složitých složek, štítkování uživatelem, per-dokumentové „soukromé/zabezpečené“ klasifikace nebo schvalování každého importu. Kontrola jen chyb a nejednoznačností.
- **Příchozí sdílená složka iCloud Drive** jako preferovaný jednoduchý transport odkudkoliv, nikoli jediný trvalý archiv ani záloha. Při implementaci ověřit spolehlivý příjem na cílovém Macu; při nemožnosti zvolit ekvivalentní nativní Zkratku s autorizovaným příjmem na server.
- **Etapa 1 — nová společná Airtable base „Rodina“:** bezpečně sjednotit čtyři stávající báze **Auto, Dokumenty, Nákupy a Rekonstrukce Světice**. **Dokumenty** v nové base jsou centrální archiv originálů, navázaný na majetek, události a projekty. Paperless-ngx není potřeba. Zpracování/OCR provádí worker, výsledky zapisuje do nové Airtable evidence a Lumi je čte přes kontrolovaný adaptér. Podrobná struktura a migrace jsou v [návrhu sjednocení](2026-11-22-unified-family-airtable.md).
- **Etapa 2 — Lumi:** po ověřeném exportu originálů, metadat **a vazeb mezi tabulkami** se kanonické úložiště přesune z nové Airtable base „Rodina“ do Lumi (spravovaný file store + SQLite); Airtable dočasně zůstane read-only archivačním zdrojem. **Zkratky, skenování ani dotazy rodiny se migrací nemění.**
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

## 4. Etapa 1 — sjednocená Airtable base `Rodina`

Původní **Auto**, **Dokumenty**, **Nákupy** a **Rekonstrukce Světice** jsou samostatné Airtable báze. Jejich data se mají sjednotit do **nové jedné base `Rodina`** s oddělenými vzájemně propojenými tabulkami. Schémata čtyř zdrojů byla ověřena read-only. Navrhované tabulky, konkrétní mapování dosavadních polí, vazeb, příloh, záruk a všech kontrol rekonstrukce, migrační manifest a akceptační scénáře jsou závazně popsané v [návrhu sjednocení](2026-11-22-unified-family-airtable.md) po jeho schválení vlastníkem. **Do té doby jde o návrh.**

- Nové `Dokumenty`: originály, OCR, datum, typ, vystavitel, poznámky a stabilní UUID; vazby na `Majetek`, `Události`, `Projekty`.
- `Majetek`: auta a pořízené výrobky včetně data nákupu, prodejce, délky záruky a výpočtu jejího konce. Účtenky, fotky a manuály se přiřazují jako odkazy na centrální dokumenty.
- `Události`: datum, servis, tachometr, stav, kategorie a související dokumenty; vychází z původního Auto.
- `Projekty` a osm původních detailních tabulek rekonstrukce: zachovat požadavky, kontroly, otevřené body, etapy, zdroje, rozhodnutí, rozpočet i historické náměty a všechny jejich aktivní `linked records`. Projektové `Zdroje` se s dokumenty neztotožňují bez prokazatelné vazby.
- Technická metadata a zdrojová provenance: neměnné `document_uuid`, mapování původních record/attachment ID, jednotlivé SHA-256, původní souborové formáty, autoritativní ruční opravy. Interní Airtable ID a API tokeny **nepatří do veřejného repozitáře**.

**Import:** iCloud Drive *Příchozí* → ověřená synchronizace na dostupném Macu / kompatibilní bezpečný přijímací endpoint → OCR/klasifikace ve workeru → uložení originálu a metadat do nové `Rodina / Dokumenty` → propojení s doménovým záznamem → potvrzení. Mobilní Zkratka neobsahuje Airtable API token.

**Migrace ze čtyř bází:** nejprve plný export a záloha původních záznamů **i binárních příloh**, potom syntetický/vzorkový import, dvouprůchodové vytvoření záznamů + vazeb, checksum a count rekonsiliace, řízené přepnutí writeru; původní čtyři báze zatím ponechat read-only, nic automaticky nemazat. Odkazy ke stažení Airtable příloh přes API nejsou trvalé (typicky krátkodobé), proto ukládat referenci a při použití získat platný odkaz.

## 4a. Etapa 2 — přesun z `Rodina` do Lumi

Cílová architektura: originály v nezávislém spravovaném file store na domácím serveru, kanonická metadata v existujícím cílovém SQLite, vazby na Tasks/Projects/Areas/Context Graph a citace přes PACT Resolver. Bez paralelní nové databáze znalostních „pravd“, bez povinného Paperless-ngx.

Prostřednictvím přenosného manifestu a stabilních UUID exportovat všechny Airtable dokumenty i obsahové přílohy, majetek, události, projekty a rekonstrukční vazby. Ověřit počty souborů, SHA-256 a integritu dat, identitu aktuálních verzí i ručně opravená pole. Přepnutí musí být řízené a obnovitelné; Airtable se dočasně mění jen na read-only archiv. **Neztratit vazby rekonstrukce, záruky, historické dokumenty ani citace.** iPhone Zkratky, název příchozí složky a práce rodiny s Lumi zůstávají stejné.

## 5. Přístup a hranice vůči existujícímu Lumi

**MVP může být owner-only.** Současný profil `personal-v1` má jediného vlastníka a soukromé Oblasti. Zamýšlená společná rodinná čtení/zápisy **neobcházejí** identity a Area ACL: zpřístupnění všem členům rodiny přes Lumi až po produkčním R5 (pozvánky, sdílená Oblast, členství, use-time ACL, revokace a testy). Sdílená iCloud *příchozí schránka* může mezitím sloužit členům k podání dokumentu, ale **sama negarantuje víceuživatelský přístup v Lumi ani oprávnění k publikaci odvozených znalostí**. Zajistit, že rodinou předané dokumenty jsou skutečně určeny pro společný archiv; případnou citlivou výjimku řešit mimo tento MVP.

Nezavádět nový veřejně dostupný bezautentizační endpoint, přímý přístup modelu k souborům nebo SQLite, nevynechávat PACT Resolver. Úryvky, názvy, výsledky, počet, náhledy, exporty a cache podléhají efektivním právům aktéra. Integrace s HumanWiki neuděluje souhlas s profilováním členů rodiny ani automatickým zveřejněním osobní preference. **Zvláště dokumenty dětí / třetích osob** nezakládají samy o sobě potvrzený osobní claim.

- Dokumentový import je **samostatný explicitně zapnutý zdroj**. Neobchází H1-real blokaci [#400](https://github.com/Kocooour/AI-executive/issues/400) pro reálný HumanWiki import; tento dokument neautorizuje import Gmail těl, příloh ani plošné prohledávání schránek. Ručně předaný soubor a automatické čtení celé pošty jsou různé souhlasy.
- **Výchozí AI extrakce lokálně**, bez odeslání celé rodinné dokumentace externím modelům. Externí AI až po samostatném výslovném opt-in a kontrolách vhodnosti dat.
- Dokumenty jsou **nedůvěryhodný vstup**: izolované parsování/OCR, omezení zdrojů, ochrana proti zip bombám a path traversal, kontrola škodlivých formátů, žádné vykonávání instrukcí z textu dokumentu (prompt injection).
- **Zálohy a obnova zahrnují originály i SQLite metadata**, kontrolu souladnosti manifestů/checksumů a pravidelně zkoušené obnovy. iCloud není jediná kopie. Export má přenositelný formát, žádné vazby pouze na absolutní cestu serveru.
- Pozdější výmaz a revokace přístupu se promítnou i do indexů a řízených odvozenin dle existujícího bezpečnostního kontraktu; nepředstírat odstranění již stažených kopií.

## 6. MVP, mimo rozsah a podmínky zavedení

**MVP (jediný vertikální scénář):** po ověřeném sjednocení čtyř původních bází do nové `Rodina`: iPhone Soubory → nativní sken → iCloud Příchozí → uložení originálu do **`Rodina / Dokumenty`** → OCR/metadata → nalezení v Lumi s citací a otevřením původního PDF z Airtable. Vedle toho otestovat „Sdílet → Do rodinného archivu“ pro PDF a uložení z Macu/PC. Bez vlastní iOS aplikace, bez Paperless, bez nových položek spodní navigace.

**Mimo MVP:** automatický import pošty; plně autonomní zakládání nebo změna úkolů, placení a smluv; per-dokumentová přístupová politika; veřejné sdílení; vlastní webové DMS UI; automatický export do HumanWiki. Lokální AI model i samotný hosting na domácím Macu jsou cílové preference, nikoli předstíraný existující provoz.

**Postup:** (1) bez změn dat inventura a záloha čtyř bází včetně příloh, linked-records a automatizací; (2) odsouhlasení nové `Rodina` struktury a vytvoření izolované nové base; (3) syntetický/vzorkový test a plná dvouprůchodová migrace všech záznamů/příloh/vazeb s kontrolním manifestem; (4) ověřit iPhone sken/Zkratky, iCloud příjem a reálné limity Airtable attachment API; (5) idempotentní import/OCR a owner-private čtení v Lumi přes PACT/citace; (6) po samostatném schválení reálného importu a release branách produkční přepnutí na `Rodina`; (7) pozdější přenos do Lumi se stejným uživatelským tokem; (8) plné rodinné sdílení přes Lumi až po R5. Není to nový aktivní milník aktuální roadmapy.

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
| DOC-13 | Export ze čtyř původních Airtable bází, konsolidace do `Rodina` a pozdější přenos do Lumi zachová každý záznam, přílohu a linked-record vazbu (počty + SHA-256), stabilní UUID, metadata i ruční opravy; druhý průchod je idempotentní. |
| DOC-14 | Po kontrolovaném přepnutí z Airtable do Lumi funguje stejná iPhone Zkratka a stejná uživatelská otázka/citace; žádná původní příloha se nemaže bez výslovného rozhodnutí. |

**Rozhodnutí ponechaná implementaci:** schválení návrhu nové `Rodina` base, kompatibilita iCloud synchronizace na konkrétním hostu, typy polí/vztahů v nové Airtable struktuře, attachment API limity a typy, OCR engine a lokální model po benchmarku, provozní frekvence importu, pravidla úklidu příchozí složky, plán migrace. Žádné z těchto rozhodnutí nesmí změnit uživatelskou jednoduchost ani bezpečnostní hranice bez review.
