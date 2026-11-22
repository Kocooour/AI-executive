# Rodinný archiv dokumentů pro Lumi — zadání a návrh řešení (2026-11-22)

**Stav:** vlastníkem potvrzený produktový směr, **návrh technického provedení**, zatím **neimplementováno / nenasazeno**. Tento dokument neaktivuje nový zdroj dat, import skutečných dokumentů, R5 ani žádnou produkční integraci. Technické detaily a zavedení podléhají navazujícímu issue, bezpečnostnímu review a release branám. Navazuje na [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [ROADMAP](../ROADMAP.md) a [rodinnou HumanWiki](2026-11-20-humanwiki-personal-family-memory.md).

## 1. Produktový cíl a schválená zjednodušení

Jednoduchý **společný rodinný digitální archiv** smluv, účtenek, záručních listů, návodů, potvrzení, faktur, dokladů k domu, autu apod. Člen rodiny dokument pouze naskenuje nebo nahraje z iPhonu, Macu či PC. Systém sám přečte obsah, vytěží návrh metadat, zařadí jej do evidence a zpřístupní jej Lumi pro citovatelné odpovědi, hledání a případná upozornění.

V první verzi:
- **Žádná nová mobilní aplikace** ani povinné rozhraní pro třídění; na iPhonu se používají nativní **Soubory, skener dokumentů, Sdílet a Zkratky**.
- **Jedna společná evidence**, bez složitých složek, štítkování uživatelem, per-dokumentové „soukromé/zabezpečené“ klasifikace nebo schvalování každého importu. Kontrola jen chyb a nejednoznačností.
- **Příchozí sdílená složka iCloud Drive** jako preferovaný jednoduchý transport odkudkoliv, nikoli jediný trvalý archiv ani záloha. Při implementaci ověřit spolehlivý příjem na cílovém Macu; při nemožnosti zvolit ekvivalentní nativní Zkratku s autorizovaným příjmem na server.
- **Lumi + originální soubory + jednoduchá evidence** jsou preferovaný start; Paperless-ngx ani jiná samostatná DMS platforma není požadavkem MVP. Použít až při prokazatelné potřebě.
- „Otevřený pro rodinu“ **neznamená veřejný na internetu**: přístup mají jen autorizovaní členové domácnosti; základní autentizace, transportní bezpečnost, ochrana před smazáním a zálohy zůstávají.

## 2. Uživatelské scénáře

**A. Papír na iPhonu:** V aplikaci Soubory otevřít sdílené *Rodinný archiv / Příchozí* → *Skenovat dokumenty* → uložit vícestránkové PDF. Alternativou je zástupce/zkratka na ploše, **jen pokud** ji lze spolehlivě sestavit z podporovaných akcí iOS; neslibovat automatické předání výstupu nativního skeneru ze Zkratek bez ověření. Bez ručního zadávání názvu, typu či data.

**B. PDF, fotografie či soubor:** Na iPhonu přes nabídku *Sdílet → Do rodinného archivu* (Zkratka pro uložení do příchozí složky), z Macu/PC přetažením nebo uložením do synchronizované složky. Nepodporovaný typ se srozumitelně označí; nahrání se nesmí tvářit jako zpracování.

**C. Použití v Lumi:** Např. „Kdy končí pojištění auta?“, „Najdi poslední revizi kotle“, „Kde je návod k vysavači?“. Lumi odpoví výhradně z aktuálně dostupného obsahu, uvede konkrétní dokument, stránku či úryvek a odkaz na otevření originálu. Neznámá/nejistá data nepodává jako fakta.

**D. Výjimka:** Nečitelný sken, neurčitý vlastník, více kandidátů pro přiřazení, konflikt dat nebo chyba importu → položka *Ke kontrole* s minimální jednorázovou opravou. Běžné importy nevyžadují schválení.

## 3. Logický tok

1. **Příjem** (iCloud folder adapter; později volitelně přímý upload): detekovat nový stabilně dosynchronizovaný soubor; nezpracovávat neúplný zápis. Zdokumentovat konektivitu, prodlevu a chyby synchronizace, případně stav „čeká na synchronizaci“.
2. **Bezpečné převzetí:** validovat typ, limity velikosti/stran a skutečnou čitelnost; na serveru vytvořit neměnnou kopii originálu, SHA-256 a stabilní `document_id`. Duplicitní doručení je idempotentní, obsahový duplikát se propojí či označí bez ztráty původních zdrojových informací.
3. **Zpracování:** extrakce textu z PDF/dokumentů, OCR pro skeny/fotografie a volitelná lokální multimodální extrakce. Stavové kroky `received → stored → extracted → classified → indexed` a `needs_review/failed`; opakovatelná bezpečná fronta s diagnostikou.
4. **Metadata:** nabídnout strojově odvozený typ dokumentu, srozumitelný název, datum vystavení, případnou platnost/termín, vystavitele, předmět (člen domácnosti / auto / dům / zařízení / projekt), číslo smlouvy či dokladu a klíčové hodnoty relevantní k typu. Nevyplňovat neexistující hodnoty odhadem.
5. **Indexace:** přesný text, stránky, metadata a vyhledávací index pro Lumi; odvozený index je obnovitelný. Originál a kanonická metadata jsou zdrojem pravdy. Případné informace o entitách do Context Graphu jen s dohledatelnou proveniencí a odpovídajícím `review` stavem.
6. **Dotazy a upozornění:** Lumi vyhledává přes serverový **PACT Context Resolver** a vydává citace na dokument. U končící platnosti smí nabídnout úkol/připomínku, ale její vytvoření či jiná akce zachovává existující pravidla schválení, audit a Undo. Důležitý termín nelze zaměnit za automaticky potvrzený závazek.
7. **Příchozí soubor neodstranit jen na základě přijetí:** úklid až po potvrzeném trvalém převzetí a ověřené politice záloh; nedovolit, aby iCloud synchronizované smazání zničilo jediný exemplář.

## 4. Návrh minimálního datového kontraktu

Preferovaná technická realizace na vlastním serveru: **kanonické metadata v existujícím cílovém SQLite**, originály v samostatném spravovaném souborovém úložišti (ne v Dexie nebo klientském indexu); případná provázanost na Tasks/Projects/Areas/Notes/Context Sources přes stabilní ID. Nezavádět paralelní „pravdivostní“ databázi. Konkrétní schéma navrhnout až s implementací.

Minimální logická položka:
- `document_id`, `sha256`, interní locator originálu, MIME/velikost/počet stran, časy přijetí a zpracování, stav importu a verzovaný pipeline/parser;
- deklarovaná vstupní cesta, kanál a **jen prokazatelná** identita předávajícího (sdílená iCloud složka sama nemusí garantovat autorství);
- název, druh, vystavitel, datace, datum expirace/termínu, typované identifikátory a vazby na rodinné objekty; každé vytěžené pole má `source_locator` (strana/úryvek), míru jistoty a stav `extracted / user_corrected / confirmed`;
- primární cílová **Oblast**, revize změn, provenance, případná poznámka k výjimce a audit oprav;
- oddělit fakta přímo z dokumentu od AI interpretace. Oprava člověkem nesmí být přepsána při opětovné extrakci bez výslovného rozhodnutí.

**Vyhledávání** nesmí vracet falešně aktuální tvrzení ze zrušených/nahrazených verzí; dokumenty lze propojit jako `supersedes/superseded_by`. Odpověď rozlišuje platnost, nejistotu a zdroj.

## 5. Přístup a hranice vůči existujícímu Lumi

**MVP může být owner-only.** Současný profil `personal-v1` má jediného vlastníka a soukromé Oblasti. Zamýšlená společná rodinná čtení/zápisy **neobcházejí** identity a Area ACL: zpřístupnění všem členům rodiny přes Lumi až po produkčním R5 (pozvánky, sdílená Oblast, členství, use-time ACL, revokace a testy). Sdílená iCloud *příchozí schránka* může mezitím sloužit členům k podání dokumentu, ale **sama negarantuje víceuživatelský přístup v Lumi ani oprávnění k publikaci odvozených znalostí**. Zajistit, že rodinou předané dokumenty jsou skutečně určeny pro společný archiv; případnou citlivou výjimku řešit mimo tento MVP.

Nezavádět nový veřejně dostupný bezautentizační endpoint, přímý přístup modelu k souborům nebo SQLite, nevynechávat PACT Resolver. Úryvky, názvy, výsledky, počet, náhledy, exporty a cache podléhají efektivním právům aktéra. Integrace s HumanWiki neuděluje souhlas s profilováním členů rodiny ani automatickým zveřejněním osobní preference. **Zvláště dokumenty dětí / třetích osob** nezakládají samy o sobě potvrzený osobní claim.

- Dokumentový import je **samostatný explicitně zapnutý zdroj**. Neobchází H1-real blokaci [#400](https://github.com/Kocooour/AI-executive/issues/400) pro reálný HumanWiki import; tento dokument neautorizuje import Gmail těl, příloh ani plošné prohledávání schránek. Ručně předaný soubor a automatické čtení celé pošty jsou různé souhlasy.
- **Výchozí AI extrakce lokálně**, bez odeslání celé rodinné dokumentace externím modelům. Externí AI až po samostatném výslovném opt-in a kontrolách vhodnosti dat.
- Dokumenty jsou **nedůvěryhodný vstup**: izolované parsování/OCR, omezení zdrojů, ochrana proti zip bombám a path traversal, kontrola škodlivých formátů, žádné vykonávání instrukcí z textu dokumentu (prompt injection).
- **Zálohy a obnova zahrnují originály i SQLite metadata**, kontrolu souladnosti manifestů/checksumů a pravidelně zkoušené obnovy. iCloud není jediná kopie. Export má přenositelný formát, žádné vazby pouze na absolutní cestu serveru.
- Pozdější výmaz a revokace přístupu se promítnou i do indexů a řízených odvozenin dle existujícího bezpečnostního kontraktu; nepředstírat odstranění již stažených kopií.

## 6. MVP, mimo rozsah a podmínky zavedení

**MVP (jediný vertikální scénář):** iPhone Soubory → nativní sken → iCloud Příchozí → trvalé převzetí na server → OCR/metadata → nalezení v Lumi s citací a otevřením původního PDF. Vedle toho otestovat „Sdílet → Do rodinného archivu“ pro PDF a uložení z Macu/PC. Bez vlastní iOS aplikace, bez Paperless, bez nových položek spodní navigace.

**Mimo MVP:** automatický import pošty; plně autonomní zakládání nebo změna úkolů, placení a smluv; per-dokumentová přístupová politika; veřejné sdílení; vlastní webové DMS UI; automatický export do HumanWiki. Lokální AI model i samotný hosting na domácím Macu jsou cílové preference, nikoli předstíraný existující provoz.

**Postup:** (1) ověřit na cílovém iPhonu a Macu skutečný workflow skenu/Zkratek a chování sdílené iCloud složky při offline režimu, konfliktu a duplicitě; (2) vytvořit izolovaný syntetický import + datový model a obnovu; (3) zapojit pouze owner-private read v Lumi přes PACT a citaci; (4) po samostatném schválení reálného importu a provozních/release branách postupně zapnout; (5) plné rodinné sdílení až po R5. Není to nový aktivní milník aktuální roadmapy.

## 7. Akceptační scénáře (budoucí end-to-end)

| ID | Ověření |
|---|---|
| DOC-01 | Sken vícestránkového papíru v nativních Souborech se bez mobilní aplikace objeví jako dohledatelný dokument s otevřitelným originálem. |
| DOC-02 | Z nabídky Sdílet na iPhonu a ze souboru na Macu/PC lze přidat PDF bez ručního zadávání metadat. |
| DOC-03 | OCR českého dokumentu rozpozná text, ale nečitelný údaj nezíská falešnou jistotu; výjimka je dohledatelná k ruční opravě. |
| DOC-04 | Duplikované doručení, restart pracovníka, opožděná synchronizace a částečný soubor nezpůsobí ztrátu ani zdvojení kanonického záznamu. |
| DOC-05 | Lumi odpoví se zdrojovým dokumentem, stránkou a odkazem; neexistující nebo neplatný termín nepředstírá jako fakt. |
| DOC-06 | Přerušený import, chyba OCR i výpadek iCloud mají viditelný stav; přečtení chybného dokumentu nemůže provést tool-call nebo změnu dat. |
| DOC-07 | Po obnově jsou originály a metadata konzistentní, index lze znovu sestavit; smazání příchozího zdroje neodstraní archivovanou kopii. |
| DOC-08 | Není veřejný přístup; před R5 neumí cizí aktér získat obsah přes API, hledání, Context Resolver, náhled ani citaci. Po R5 mají přístup pouze členové autorizované společné Oblasti. |
| DOC-09 | Manuálně opravené metadata zůstanou zachovány po opakované extrakci; novější a zrušená verze dokumentu se rozlišují. |
| DOC-10 | Bez zvláštního opt-in nejde dokumentový obsah do externí AI, automatického e-mailového importu ani do profilů HumanWiki. |

**Rozhodnutí ponechaná implementaci:** kompatibilita iCloud synchronizace na konkrétním hostu, detail schématu dokumentových objektů, limity velikosti a typů, OCR engine a lokální model po benchmarku, provozní frekvence importu, pravidla úklidu příchozí složky. Žádné z těchto rozhodnutí nesmí změnit uživatelskou jednoduchost ani bezpečnostní hranice bez review.
