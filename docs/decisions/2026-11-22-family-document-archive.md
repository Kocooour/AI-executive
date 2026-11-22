# Rodinný archiv dokumentů pro Lumi — zadání a návrh řešení (2026-11-22)

**Stav:** vlastníkem potvrzený produktový směr včetně **etapy 1: existující Airtable**, následně migrace do Lumi; **návrh technického provedení**, zatím **neimplementováno / nenasazeno**. Tento dokument neaktivuje nový zdroj dat, import skutečných dokumentů, R5 ani žádnou produkční integraci. Technické detaily a zavedení podléhají navazujícímu issue, bezpečnostnímu review a release branám. Navazuje na [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [ROADMAP](../ROADMAP.md) a [rodinnou HumanWiki](2026-11-20-humanwiki-personal-family-memory.md).

## 1. Produktový cíl a schválená zjednodušení

Jednoduchý **společný rodinný digitální archiv** smluv, účtenek, záručních listů, návodů, potvrzení, faktur, dokladů k domu, autu apod. Člen rodiny dokument pouze naskenuje nebo nahraje z iPhonu, Macu či PC. Systém sám přečte obsah, vytěží návrh metadat, zařadí jej do evidence a zpřístupní jej Lumi pro citovatelné odpovědi, hledání a případná upozornění.

V první verzi:
- **Žádná nová mobilní aplikace** ani povinné rozhraní pro třídění; na iPhonu se používají nativní **Soubory, skener dokumentů, Sdílet a Zkratky**.
- **Jedna společná evidence**, bez složitých složek, štítkování uživatelem, per-dokumentové „soukromé/zabezpečené“ klasifikace nebo schvalování každého importu. Kontrola jen chyb a nejednoznačností.
- **Příchozí sdílená složka iCloud Drive** jako preferovaný jednoduchý transport odkudkoliv, nikoli jediný trvalý archiv ani záloha. Při implementaci ověřit spolehlivý příjem na cílovém Macu; při nemožnosti zvolit ekvivalentní nativní Zkratku s autorizovaným příjmem na server.
- **Etapa 1 — existující Airtable base „Dokumenty“:** současná tabulka a její pole příloh představují kanonickou evidenci a úložiště originálů. Nevytvářet novou bázi ani nepořizovat Paperless-ngx. Zpracování/OCR může provádět samostatný worker, ale výsledky zapisuje do existující Airtable evidence; Lumi ji čte přes kontrolovaný adaptér.
- **Etapa 2 — Lumi:** po ověřeném exportu originálů a metadat se kanonické úložiště přesune do Lumi (spravovaný file store + SQLite); Airtable dočasně zůstane read-only archivačním zdrojem a následně je možné jej vyřadit. **Zkratky, skenování ani dotazy rodiny se migrací nemění.**
- „Otevřený pro rodinu“ **neznamená veřejný na internetu**: přístup mají jen autorizovaní členové domácnosti; základní autentizace, transportní bezpečnost, ochrana před smazáním a zálohy zůstávají.

## 2. Uživatelské scénáře

**A. Papír na iPhonu:** V aplikaci Soubory otevřít sdílené *Rodinný archiv / Příchozí* → *Skenovat dokumenty* → uložit vícestránkové PDF. Alternativou je zástupce/zkratka na ploše, **jen pokud** ji lze spolehlivě sestavit z podporovaných akcí iOS; neslibovat automatické předání výstupu nativního skeneru ze Zkratek bez ověření. Bez ručního zadávání názvu, typu či data.

**B. PDF, fotografie či soubor:** Na iPhonu přes nabídku *Sdílet → Do rodinného archivu* (Zkratka pro uložení do příchozí složky), z Macu/PC přetažením nebo uložením do synchronizované složky. V první etapě se originál po převzetí trvale ukládá jako příloha existujícího záznamu Airtable. Nepodporovaný typ se srozumitelně označí; nahrání se nesmí tvářit jako zpracování.

**C. Použití v Lumi:** Např. „Kdy končí pojištění auta?“, „Najdi poslední revizi kotle“, „Kde je návod k vysavači?“. Lumi odpoví výhradně z aktuálně dostupného obsahu, uvede konkrétní dokument, stránku či úryvek a odkaz na otevření originálu. Neznámá/nejistá data nepodává jako fakta.

**D. Výjimka:** Nečitelný sken, neurčitý vlastník, více kandidátů pro přiřazení, konflikt dat nebo chyba importu → položka *Ke kontrole* s minimální jednorázovou opravou. Běžné importy nevyžadují schválení.

## 3. Logický tok

1. **Příjem** (iCloud folder adapter; později volitelně přímý upload): detekovat nový stabilně dosynchronizovaný soubor; nezpracovávat neúplný zápis. Zdokumentovat konektivitu, prodlevu a chyby synchronizace, případně stav „čeká na synchronizaci“.
2. **Bezpečné převzetí v etapě 1:** validovat typ, limity velikosti/stran a čitelnost; worker z příchozího souboru vypočítá SHA-256, přiřadí stabilní `document_id` a přes chráněný serverový Airtable API token uloží originál jako přílohu záznamu v existující tabulce. Potvrdit, že se příloha skutečně v Airtable uchovala (a ideálně přečíst zpět/ověřit hash), dříve než se import označí dokončeným nebo smaže dočasný zdroj. Duplicitní doručení je idempotentní. Neposílat token Airtable do distribuované iOS Zkratky; otestovat omezení přímého attachment uploadu a bezpečnou záložní metodu bez veřejně vystaveného nechráněného dokumentu.
3. **Zpracování:** extrakce textu z PDF/dokumentů, OCR pro skeny/fotografie a volitelná lokální multimodální extrakce. Stavové kroky `received → stored → extracted → classified → indexed` a `needs_review/failed`; opakovatelná bezpečná fronta s diagnostikou.
4. **Metadata:** nabídnout strojově odvozený typ dokumentu, srozumitelný název, datum vystavení, případnou platnost/termín, vystavitele, předmět (člen domácnosti / auto / dům / zařízení / projekt), číslo smlouvy či dokladu a klíčové hodnoty relevantní k typu. Mapovat do **existujících polí Airtable** bez přepisu dříve ručně zadaných hodnot; nové volby v select polích nevytvářet nekontrolovaně. Nevyplňovat neexistující hodnoty odhadem.
5. **Indexace:** přesný text, stránky, metadata a vyhledávací index pro Lumi; odvozený index je obnovitelný. **V etapě 1 jsou kanonické přílohy a metadata v Airtable**; lokální OCR text/cache/index slouží jen jako obnovitelný derivát, případně ukládat do Airtable pouze vhodně omezený výtah textu. V etapě 2 se kanonickými stanou originály + SQLite metadata v Lumi. Případné informace o entitách do Context Graphu jen s dohledatelnou proveniencí a odpovídajícím `review` stavem.
6. **Dotazy a upozornění:** Lumi vyhledává přes serverový **PACT Context Resolver** a vydává citace na dokument. U končící platnosti smí nabídnout úkol/připomínku, ale její vytvoření či jiná akce zachovává existující pravidla schválení, audit a Undo. Důležitý termín nelze zaměnit za automaticky potvrzený závazek.
7. **Příchozí soubor neodstranit jen na základě přijetí:** úklid až po potvrzeném trvalém převzetí a ověřené politice záloh; nedovolit, aby iCloud synchronizované smazání zničilo jediný exemplář.

## 4. Etapa 1 — využití existující Airtable evidence

**Ověřená Airtable struktura (2026-11-22, pouze schéma):** existuje base **„Dokumenty“**, tabulka **„Dokumenty“**, s poli `ID` (automatické číslo), `Datum`, `Kdo`, `Instituce`, `Kategorie`, `Důvod`, `Typ dokumentu`, `Poznámky` a **`Dokumenty` (více příloh)**. Nejde o novou prázdnou tabulku. Existující výběrové hodnoty a záznamy zachovat, nemigrovat ani nepřejmenovávat při pouhém zavedení importu. V veřejně přístupném repozitáři neuvádět osobní údaje, URL příloh, tokeny ani interní Airtable base/table identifikátory; mapování ID je serverová konfigurace.

| Původní pole | Použití v etapě 1 |
|---|---|
| `ID` | Ponechat jako lidsky čitelné číselné pořadí; **není** migrací stabilní globální identifikátor |
| `Datum` | Datum dokumentu (je-li známo), nikoli implicitně datum skenování |
| `Kdo` | Osoba / příslušnost, pouze při dostatečné jistotě; při nejasnosti nevybírat náhodně |
| `Instituce` | Vystavitel, jen pokud odpovídá významu a existujícím možnostem |
| `Kategorie`, `Důvod`, `Typ dokumentu` | Existující klasifikace; rozšiřovat řízeně, ne každý nový OCR termín jako automatickou volbu |
| `Poznámky` | Uživatelský komentář; AI do něj nesmí přepisovat ruční informace |
| `Dokumenty` | **Kanonické originální soubory** v attachment poli Airtable v etapě 1 |

**Nejmenší navržené rozšíření po odsouhlasení skutečného workflow:** technická stabilní `Document UUID` (pro nové i zpětně doplněné staré záznamy), `Import state` (přijato/zpracováno/ke kontrole/chyba), `SHA-256` nebo zvláštní attachment manifest při více přílohách, volitelně `Název / AI návrh`, `Platnost do`, `OCR výtah`, `Zpracováno`. Přidat pouze nutná pole; rozlišení původního a navrhovaného obsahu, verze extrakce a oprav uživatele může být v oddělené technické vrstvě s přenositelným exportem. **Zatím nic v Airtable automaticky nevytvářet.**

**Importní adaptér:** iCloud Drive *Příchozí* → ověřená synchronizace na dostupném Macu / kompatibilní bezpečný přijímací endpoint → OCR/klasifikace ve workeru → upsert do existující Airtable tabulky včetně příloh → potvrzení a evidence stavu. Zkratka na telefonu ukládá soubor pouze do příchozí složky a nikdy nedrží společný API token. Pro stávající záznamy se doplnění metadat provede jen po samostatném zálohování a schválení, bez hromadného přepisování.

**Airtable přílohy:** do trvalé evidence nesmějí proniknout krátkodobé přímé download URL z API (obvykle platnost ~2 hodiny). Ukládat stabilní `record_id`, `attachment_id`, příslušnost a volitelný checksum; pro aktuální stažení obnovit URL z Airtable API a ihned stáhnout. Odkaz pro uživatele má vést do autorizovaného záznamu/attachment vieweru nebo přes kontrolovanou Lumi gateway, nikoli k expirovanému uloženému download URL. Před implementací otestovat přímý upload příloh (limity velikosti), stránkování, API limity a zpětnou kontrolu uložení. Při výpadku musí originál bezpečně zůstat ve vstupní frontě.

## 4a. Etapa 2 — přesun do vlastního úložiště Lumi

Cílová architektura: originály v nezávislém spravovaném file store na domácím serveru, kanonická metadata v existujícím cílovém SQLite, vazby na Tasks/Projects/Areas/Context Graph a citace přes PACT Resolver. Bez paralelní nové databáze znalostních „pravd“, bez povinného Paperless-ngx.

**Přenositelný datový kontrakt od prvního dne:** globální neměnné `document_uuid`; podrobný manifest jednotlivých příloh (stabilní `attachment_uuid`, Airtable record/attachment reference, původní filename/MIME/velikost, SHA-256, URL *neukládat*); datum dokumentu, vystavitel, typ/klasifikace, osoby a vazby na rodinné objekty, platnost, provenance/kdo opravil, stav importu a verze OCR. U více příloh jednoho záznamu nepředpokládat, že každá tvoří samostatný dokument; zvolit a verzovat mapování. AI extrakce má volitelnou citaci stránky/úryvku a míru jistoty, nikoli status automaticky potvrzeného faktu.

**Řízená migrace:** (1) export kompletní tabulky včetně všech stránek z API a všech binárních příloh přes čerstvé odkazy; (2) porovnat počty záznamů i příloh, SHA-256, velikosti a manifest; (3) v Lumi obnovit stejné stabilní UUID, metadata, ruční opravy, vztahy a dokumentové verze; (4) na izolovaném datasetu ověřit OCR, citace a 100% kontrolu úplnosti; (5) zastavit nebo synchronizovat změny po exportu (delta, idempotentní opakování), explicitně přepnout jediný kanonický writer/reader; (6) po úspěšném přepnutí ponechat Airtable dočasně pouze pro čtení a až po ověřené obnovitelné záloze řešit vyřazení. **Nikdy nemazat původní Airtable data jen proto, že export doběhl bez chyby.** Mobilní workflow, jméno zkratky, citace a uživatelské dotazy musí dál fungovat.

**Pravidlo pro verze:** novější či ručně opravená hodnota nesmí být přepsána re-extrakcí; `supersedes/superseded_by` rozlišuje platné a nahrazené dokumenty.

## 5. Přístup a hranice vůči existujícímu Lumi

**MVP může být owner-only.** Současný profil `personal-v1` má jediného vlastníka a soukromé Oblasti. Zamýšlená společná rodinná čtení/zápisy **neobcházejí** identity a Area ACL: zpřístupnění všem členům rodiny přes Lumi až po produkčním R5 (pozvánky, sdílená Oblast, členství, use-time ACL, revokace a testy). Sdílená iCloud *příchozí schránka* může mezitím sloužit členům k podání dokumentu, ale **sama negarantuje víceuživatelský přístup v Lumi ani oprávnění k publikaci odvozených znalostí**. Zajistit, že rodinou předané dokumenty jsou skutečně určeny pro společný archiv; případnou citlivou výjimku řešit mimo tento MVP.

Nezavádět nový veřejně dostupný bezautentizační endpoint, přímý přístup modelu k souborům nebo SQLite, nevynechávat PACT Resolver. Úryvky, názvy, výsledky, počet, náhledy, exporty a cache podléhají efektivním právům aktéra. Integrace s HumanWiki neuděluje souhlas s profilováním členů rodiny ani automatickým zveřejněním osobní preference. **Zvláště dokumenty dětí / třetích osob** nezakládají samy o sobě potvrzený osobní claim.

- Dokumentový import je **samostatný explicitně zapnutý zdroj**. Neobchází H1-real blokaci [#400](https://github.com/Kocooour/AI-executive/issues/400) pro reálný HumanWiki import; tento dokument neautorizuje import Gmail těl, příloh ani plošné prohledávání schránek. Ručně předaný soubor a automatické čtení celé pošty jsou různé souhlasy.
- **Výchozí AI extrakce lokálně**, bez odeslání celé rodinné dokumentace externím modelům. Externí AI až po samostatném výslovném opt-in a kontrolách vhodnosti dat.
- Dokumenty jsou **nedůvěryhodný vstup**: izolované parsování/OCR, omezení zdrojů, ochrana proti zip bombám a path traversal, kontrola škodlivých formátů, žádné vykonávání instrukcí z textu dokumentu (prompt injection).
- **Zálohy a obnova zahrnují originály i SQLite metadata**, kontrolu souladnosti manifestů/checksumů a pravidelně zkoušené obnovy. iCloud není jediná kopie. Export má přenositelný formát, žádné vazby pouze na absolutní cestu serveru.
- Pozdější výmaz a revokace přístupu se promítnou i do indexů a řízených odvozenin dle existujícího bezpečnostního kontraktu; nepředstírat odstranění již stažených kopií.

## 6. MVP, mimo rozsah a podmínky zavedení

**MVP (jediný vertikální scénář):** iPhone Soubory → nativní sken → iCloud Příchozí → trvalé uložení originálu jako přílohy **existujícího Airtable záznamu** → OCR/metadata v téže evidenci → nalezení v Lumi s citací a otevřením původního PDF z Airtable. Vedle toho otestovat „Sdílet → Do rodinného archivu“ pro PDF a uložení z Macu/PC. Bez vlastní iOS aplikace, bez Paperless, bez nových položek spodní navigace.

**Mimo MVP:** automatický import pošty; plně autonomní zakládání nebo změna úkolů, placení a smluv; per-dokumentová přístupová politika; veřejné sdílení; vlastní webové DMS UI; automatický export do HumanWiki. Lokální AI model i samotný hosting na domácím Macu jsou cílové preference, nikoli předstíraný existující provoz.

**Postup:** (1) ověřit iPhone sken/Zkratky, iCloud příjem a reálné limity Airtable attachment API na syntetickém souboru mimo skutečnou tabulku; (2) navrhnout minimální **aditivní** změny existujícího Airtable schématu a zálohu stávajících záznamů; (3) vytvořit izolovaný syntetický import, OCR a idempotentní Airtable adaptér; (4) zapojit owner-private read v Lumi přes PACT a citaci; (5) po schválení reálného importu a release branách zapnout první provoz; (6) později samostatně plánovaná migrace s kontrolou úplnosti; (7) plné rodinné sdílení přes Lumi až po R5. Není to nový aktivní milník aktuální roadmapy.

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
| DOC-11 | Nový import přidá do **existující** Airtable tabulky dokument a binární přílohu; stávající záznamy, výběrové hodnoty a poznámky nezmění. Mobilní zkratka neobsahuje Airtable API token. |
| DOC-12 | Lumi otevře aktuální přílohu i po expiraci dřívější Airtable download URL, bezpečně obnoví autorizovaný přístup; výpadek API přizná místo smyšleného odkazu. |
| DOC-13 | Export z Airtable a obnovení v Lumi zachová každý záznam a každou přílohu (počty + SHA-256), stabilní UUID, metadata i ruční opravy; druhý průchod je idempotentní. |
| DOC-14 | Po kontrolovaném přepnutí z Airtable do Lumi funguje stejná iPhone Zkratka a stejná uživatelská otázka/citace; žádná původní příloha se nemaže bez výslovného rozhodnutí. |

**Rozhodnutí ponechaná implementaci:** kompatibilita iCloud synchronizace na konkrétním hostu, aditivní rozšíření existujících Airtable polí, attachment API limity a typy, OCR engine a lokální model po benchmarku, provozní frekvence importu, pravidla úklidu příchozí složky, plán migrace. Žádné z těchto rozhodnutí nesmí změnit uživatelskou jednoduchost ani bezpečnostní hranice bez review.
