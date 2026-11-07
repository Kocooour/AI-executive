# Rozhodnutí 2026-11-08 — HumanWiki, Context Bootstrap & Continuous Learning

**Status:** schválený cílový produktový kontrakt a plán; žádná automatická ingestace, nový konektor ani produkční migrace nejsou tímto dokumentem aktivovány.

**Kanonické odkazy:** [produkt](../PRODUCT.md), [architektura](../ARCHITECTURE.md), [UX](../UX-UI.md), [roadmapa](../ROADMAP.md), [Gmail v1–v4](../MAIL-CONNECTORS.md), [sémantická paměť Stage 1](../semantic-memory-stage1.md).

## Záměr

Lumi vybuduje **osobní, propojenou, průběžně aktualizovanou a člověkem editovatelnou znalostní mapu** ve stylu HumanWiki. Vstupem jsou uživatelem dodané exporty historických konverzací ChatGPT a Claude, vybrané osobní e-maily (Gmail a případně iCloud Mail), existující kanonické objekty Lumi a nové interakce zachycené přímo v Lumi. Jde o lidsky čitelný pohled na tentýž Context Graph, **nikoli** o druhý systém pravdy, samostatnou wiki databázi, kopii všech schránek nebo paralelní HumanAgentWiki.

Účelem je propojit lidi, organizace, projekty, témata, preference, události, závazky a rozhodnutí s jejich důvody, historickými změnami a citovatelnými zdroji. Znalosti může Lumi použít k odpovědím a návrhům jen v rámci stávajícího Context Resolveru, autorizace a review pravidel. Uživatel může znalost otevřít, opravit, odmítnout, skrýt, exportovat a vyžádat si její odstranění včetně závislých odvozených artefaktů.

## Co znamená import

1. **ChatGPT a Claude — import minulosti:** uživatel předá export ve skutečně dostupném formátu; Lumi jej bezpečně načte jako izolovaný, soukromý zdroj. Použití API modelů ani připojení účtu samo o sobě nezajišťuje přístup k úplné historii konverzací. Dostupnost, rozsah a formát exportů se ověří při implementaci; chybějící obsah se nepředstírá.
2. **Budoucí nové interakce:** Lumi automaticky zachycuje pouze interakce uskutečněné v jejím vlastním klientu/API se zapnutým příslušným souhlasem. Nové konverzace vedené mimo Lumi v ChatGPT nebo Claude vyžadují další explicitní export/import nebo později zvlášť schválený integrátor; žádný fiktivní live-sync.
3. **Gmail:** stávající Gmail v1–v4 zůstává read-only a metadata-only, bez automatické analýzy těla zpráv. Cílové počáteční načtení historických e-mailů a inkrementální obsahová synchronizace jsou **samostatnou budoucí funkcí** s novým, účetně i rozsahem odděleným opt-in. Stávající povolení synchronizace metadat není povolením vytvořit osobní profil z obsahu pošty. Před ingestací musí být zřejmé účty, složky/štítky, časový rozsah, politika citlivosti, uchovávání, cíloví příjemci AI a způsob vypnutí/smazání. Oprávnění zůstává pouze pro čtení; žádné odesílání, třídění ani úpravy zpráv.
4. **iCloud Mail:** budoucí samostatný IMAP adaptér po bezpečnostní a provozní revizi; tajemství šifrovaná, bez automatického zapnutí a bez předpokladu, že existující kalendářové připojení dává poštovní oprávnění.
5. **Zdroje z Lumi:** současné úkoly, projekty, poznámky, context claims a rozhodnutí mají přednost jako explicitně potvrzené kanonické entity. Import je nesmí tiše přepsat. Poznámka v chatu nikdy sama nevytvoří úkol, schválenou relaci ani externí akci.

## Model znalostí a nejistoty

- Zachovat stávající canonical entities, context_subjects, context_claims, context_sources, context_evidence, relations, audity/revize a jejich scoped identitu. „Wiki stránka“ je odvozené zobrazení autorizačně dostupných částí grafu a může odkazovat na projekt, úkol nebo poznámku; nevytváří nezávislou pravdu.
- Pro každé navrhované tvrzení evidovat identitu zdroje a přesný locator (např. export/message/thread ID + segment), čas pozorování, období platnosti, citlivost, autora/kontext, confidence extraction (není review), revizi a stav **navrženo / potvrzeno / sporné / zastaralé / odmítnuto**. Návrhy nesmějí být bez uživatelské revize zobrazeny jako ověřená fakta ani využity ke konkrétním rizikovým akcím.
- Existence více podobných výroků neznamená nezávislé důkazy. Importy mohou obsahovat citace téhož textu, modelová shrnutí a omyly. Deduplikovat podle stabilního zdrojového ID a obsahového fingerprintu, spojovat pouze s doložitelným typem vztahu; identitu lidí a vazby na rodinu/práci neodvozovat pouze z příjmení nebo společné e-mailové adresy.
- Při novém časově odlišném tvrzení zachovat historii a význam „platilo tehdy / platí nyní“. Konflikty nabídnout k přezkoumání; potvrzené rozhodnutí se bez schválení nepřepisuje. Uživatelská oprava kanonického claimu se projeví také v Chat/Context Resolver a wiki.
- Struktura: **Lidé**, **Organizace a místa**, **Projekty**, **Témata/preference**, **Události/závazky**, **Rozhodnutí a historie**. Uživatelsky jde o navigační kategorie, ne o nové datové prostory ani automaticky veřejné profily.
- Zdrojové surové texty a přílohy se ve výchozím stavu nearchivují do trvalé znalostní vrstvy. Pro výslovně povolený krátkodobý import lze použít šifrovanou, izolovanou vstupní karanténu s omezením velikosti, retencí a bezpečným výmazem; minimální source locator a schválená evidence zůstávají jen podle schválené politiky. Importovaný zdroj zůstává nedůvěryhodným obsahem (prompt injection se nesmí stát instrukcí).

## Oprávnění a cloudové modely

- Každý import a každý nově extrahovaný osobní údaj je výchozím stavem v **Osobní / Nezařazeno** konkrétního aktéra. Vše je jen průnik autorizovaného čtení; Sdílený je jiný uživatelský prostor s explicitní Oblastí a členy. Přesun odvozeného tvrzení, souhrnu nebo wiki stránky do Sdíleného vyžaduje přezkoumání všech předaných zdrojových detailů a výslovné schválení; žádné skryté publikování soukromého úryvku přes citace, počet, autocomplete, embedding či graf.
- Zdravotní, finanční, přístupové, rodinné a jiné potenciálně citlivé údaje i osobní data třetích osob mají přísnější klasifikaci; importní návrh není oprávněním z nich vytvořit trvalý personalizovaný profil. Chybějící klasifikace znamená fail-closed. Povolená granularita paměti, uchovávání a případné potvrzení se stanoví po typech zdrojů.
- OpenAI a Anthropic jsou **oddělení poskytovatelé výpočetní analýzy**, nikoli správci kanonické paměti Lumi. Jednomu lze zadat extrakci, jinému dobrovolný audit sporné informace. Dva modely nejsou povinné a jejich souhlas nenahrazuje evidence/review.
- Základní režim je serverově/lokálně zpracovávaný obsah. Přenos konkrétního soukromého obsahu do externí AI je default-off a vyžaduje srozumitelný opt-in podle účtu, typu obsahu, cílového poskytovatele a případné per-item potvrzení podle citlivosti. Confidential/restricted se běžně neposílá externímu modelu ani MCP. Změna poskytovatele, endpointu nebo trust režimu obnovuje souhlas, nezdědí předchozí oprávnění. Smluvní retenční pravidla a skutečný egress je nutné ověřit.
- Odpojení účtu, odvolání souhlasu, smazání původního importu nebo změna ACL vyžádá zrušení souvisejících návrhů, revalidaci všech claims založených pouze na takovém zdroji a odstranění/obnovu odvozených indexů, cache, náhledů, souhrnů, embeddings a exportů v Lumi. Neexistuje přístup přes historickou revizi. Backup-restore je restore-generation fenced; dříve vyvezené kopie u třetích stran nelze zpětně odebrat.
- Události a obsah s nedostatečnou evidencí se nesmějí proměnit v úkol, automaticky odeslaný e-mail, změnu kalendáře, pozvánku nebo neoprávněně přístupný profil. Všechny takové kroky nadále vyžadují běžný proposal → approval → audit.

## Uživatelský tok (cílové UX)

V „Více → Kontext“ či v univerzálním hledání uživatel otevře **HumanWiki**. Vstupní stránka ukáže čitelné kategorie, nedávno aktualizované položky, filtrování Vše / Osobní / Sdílené a stav synchronizovaných zdrojů. Na desktopu je dostupná přes hledání/side panel; **nevzniká nová spodní mobilní záložka**. „Můj plán“ zůstává vstupním pracovním přehledem.

Stránka entity obsahuje krátký souhrn, **Co aktuálně platí**, vztahy, rozhodnutí/historii, srozumitelnou evidenci a bezpečné „Proč to vím?“ s přechodem na konkrétní oprávněný zdroj. Člověk upraví nebo odmítne tvrzení jednou; změna se projeví v každém autorizovaném pohledu a AI odpovědích. Stav navrženo/ověřeno/sporné/zastaralé je textový, nikoliv pouze barevný. UI nikdy nevydává neúplný, dosud neindexovaný import za kompletní profil.

Importní průvodce před každým během ukáže původ, časové rozpětí, odhad rozsahu, privacy nastavení a důsledky. Po zpracování nabídne **frontu ke kontrole**, přehled rozporů, duplikátů a pokrytí. Až přijetí odpovídající znalosti dovolí označit ji jako potvrzenou. Tlačítka „Zastavit import“, „Zrušit souhlas“, „Smazat importované informace“ jsou oddělená a jejich rozdílný dopad je vysvětlen.

## Implementační pořadí a brány

| Etapa | Předmět | Závislosti a dodací brána |
|---|---|---|
| **H0 · návrh** | schéma zdrojů, provenance, audit/retence, threat model, syntetické fixture pro exporty, UX importní fronty | může probíhat paralelně s R2d/R3; pouze dokumentace, testovací adaptér, žádný produkční obsah |
| **H1 · bootstrap P0** | ruční import exportů ChatGPT a Claude do izolovaného stagingu, idempotence a návrhy claims, explicitní potvrzování | dokončené serverové identity/ACL/sync a ochrany Context Resolver; žádná aktivace v běžném UI před R4 |
| **H2 · HumanWiki P0/P1** | čtení kanonického grafu, editace/review, historie, citace, globální hledání a bezpečné deeplinky | H1 + autorizované context read/writes, cache/revokace, mobile UX; žádný nový primární tab |
| **H3 · pošta P1** | výslovně povolený Gmail content bootstrap a řízený incremental sync; iCloud IMAP po vlastní bezpečnostní revizi | H1/H2, oddělený opt-in od metadat v4, OAuth/IMAP privacy, retention, audit, rate limits, izolované testy; R4 production gate |
| **H4 · continuous learning P1** | nové interakce uvnitř Lumi, revalidace tvrzení a opt-in sledování vybraných zdrojů | H2/H3 podle typu zdroje, monitoring, odpojování, lidský review; externí chaty bez vlastního capture integrátoru nepřitékají |

Etapy jsou produktové milníky, ne tvrzení o dokončení. R2d → R3 → R4 zůstává kritickou cestou pro produkční aktivaci; H0 a čistě syntetické H1 mohou být vyvíjeny souběžně. Tento dokument **není** souhlasem s produkčním cutoverem, resetem, hromadným exportem privátních schránek, spuštěním cloudového zpracování ani změnou dosavadního Gmail v4.

## Povinné akceptační scénáře

1. Dvojí import stejného bundle (i po přerušení/restartu) nezaloží duplicitní claims, osoby, vztahy ani provenance; checkpoint se posune jen po trvalém zapsání.
2. ChatGPT/Claude historie s neúplnými nebo neznámými formáty vrátí srozumitelné chyby, možnost pokračovat a přesný seznam importovaných zdrojů; chybějící historii nesimuluje.
3. Stejný projekt v chatu a v e-mailu vytvoří jednu navrženou vazbu se dvěma lokátory, ne dvě automaticky potvrzené pravdy; protichůdné termíny zobrazí historii a konflikt.
4. Tvrzení o jiné osobě, citlivá informace a informace bez dostatečné klasifikace zůstanou soukromé/nepotvrzené a nesmějí být odeslány externí AI podle výchozího nastavení.
5. Otevřený wiki článek i odkazy, výsledky hledání, počty, autocomplete, cache, embeddings, export a AI odpověď respektují v každém kroku identitu, Oblast, sensitivity, review, source ACL a restore-generation. Změna členství uprostřed požadavku fail-closed.
6. Uživatel opraví jeden potvrzený claim; nová verze je na stránce i v Context Resolver, původní tvrzení jen v oprávněné historii; nevznikne úkol ani automatická akce.
7. Odpojení zdroje nebo smazání importu stáhne výstupy založené pouze na něm, zabrání stale odpovědi a odstraní odvozené artefakty; doložené nezávislé zdroje jsou zachovány podle platné retention policy.
8. Gmail metadata-only v4 ani existující souhlas k OAuth nespouští žádnou analýzu těl zpráv; obsahový import je blokován bez zvláštního souhlasu.
9. Při offline nebo nedostupném AI/vektorovém indexu lze stále číst autorizovaná uložená kanonická data a lexikálně hledat; UI přiznává neúplnost.
10. Záloha/obnova a export/import zachovají review, provenance, source ACL a revize; stará offline session nesmí po restore znovu publikovat data.
11. Všechny bezpečnostní testy používají syntetické schránky a fake exporty, nikdy reálná osobní data v CI, telemetry nebo PR přílohách.
