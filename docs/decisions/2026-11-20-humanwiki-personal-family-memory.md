# Rozhodnutí 2026-11-20 — HumanWiki: osobní a rodinná paměť

**Status:** schválený cílový produktový návrh; **nikoli** dodaná funkce, oprávnění k ingestaci reálných dat nebo aktivace rodinného sdílení. Doplňuje [HumanWiki bootstrap 2026-11-08](2026-11-08-humanwiki-knowledge-bootstrap.md), [Prostory/Oblasti 2026-10-23](2026-10-23-prostory-oblasti-muj-plan.md) a [LUMI-FR-014](../PRODUCT.md#lumi-fr-014). Dosavadní pravidla mailového soukromí, H1-real, R3/R4 a revokace zůstávají beze změny a mají přednost před jakýmkoli automatickým návrhem modelu.

## 1. Účel a zásady

HumanWiki je **jediná logická osobní a rodinná znalostní vrstva nad kanonickým Context Graph v2**, nikoli další pravdivostní databáze. Každá identita může mít vlastní soukromou paměť a zároveň může v autorizovaných sdílených Oblastech vznikat společná rodinná paměť. Neexistuje globálně přístupný rodinný profil ani sdílení všech znalostí jediné osoby.

Lumi rozlišuje, **čeho se znalost týká (Oblast), o kom vypovídá (subjekt), kdo ji vlastní/zdokumentoval, z jakého zdroje pochází a komu ji lze vydat**. Individuální preference se nikdy tiše nepřenášejí na jiného člověka ani na rodinu. Oblast je organizační i autorizační kontext, ale podobnost tématu sama o sobě nepovoluje zveřejnění.

Tento dodatek nenahrazuje stávající kanonické entity Tasks / Projects / Areas / Notes / Relations, stavy `review` / `freshness` / conflict ani role členství `viewer/editor/admin`.

## 2. Prostory a Oblasti

- **Osobní**: skutečné soukromé Oblasti aktuálního uživatele; každá identita spravuje svou soukromou paměť. Osobní výchozí zápis je do soukromé Oblasti **Nezařazeno**.
- **Sdílený**: výhradně znalosti v konkrétní sdílené Oblasti, ke které má aktér aktuální členství a příslušné právo. Různé sdílené Oblasti mohou mít různá členství: „rodina“ není výjimkou z jejich ACL.
- **Vše**: pouze serverově autorizované sjednocení obou rozsahů pro daného aktéra, **nikoli třetí prostor** ani místo zápisu. `Můj plán` zůstává odlišným osobním pohledem na úkoly.
- Každá samostatná wiki znalost má **právě jednu efektivní primární Oblast**. Pokud je odvozená přímo z projektu nebo úkolu, jeho Oblast je kandidátem na klasifikaci, **nikoli automatickým svolením** ke sdílení. Projektový úkol nadále dědí Oblast projektu; pro samostatný claim se nepřidává žádná výjimka rozšiřující přístup.
- Existující Area policy zůstává **jediným uživatelským zdrojem viditelnosti**. Specifická citlivost, práva zdroje nebo souhlas smějí přístup **jen zúžit**, nikdy rozšířit nad oprávnění Oblasti. Nejde-li bezpečně uložit chráněné tvrzení do společné Oblasti, zůstane v soukromé a případný sdílený výtah musí projít zvláštním schválením.
- Názvy typu „Rodina“, „Dovolená“ nebo „Domácnost“ nejsou bezpečnostní pravidla: soukromá Oblast/projekt s takovým názvem zůstává soukromý.

## 3. Znalost a identita subjektu

Použít existující `context_subjects`, `context_claims`, `context_sources`, `context_evidence`, revize a vztahy. Znalostní tvrzení má stabilní ID, typovaný predikát/hodnotu, **subjekt**, vlastníka/autora, efektivní Oblast, zdrojový locator a speaker/provenance, citlivost, revizi, čas pozorování a platnosti; zachovává nezávislé `review=proposed|confirmed|rejected`, `freshness=current|needs_review|stale` a případný konflikt. Toto je logický kontrakt; nepožaduje nový paralelní store ani automaticky nový fyzický sloupec.

Subjektem může být ověřená osoba, rodina/skupina, domácnost, zařízení nebo jiná kanonická entita. **Subjekt ≠ vlastník ≠ aktér ≠ autor citátu ≠ člen Oblasti**. Při nejednoznačné identitě či mluvčím systém tvrzení **nepřiřadí** libovolnému členu rodiny. Citace manželky zprostředkovaná uživatelem není potvrzený výrok manželky; zachovává se skutečný speaker a role třetí strany. `assistant_generated` se nesmí povýšit na osobní fakt.

Tři rozdílné příklady (ilustrační, nikoli reálné údaje):
- `subject=uživatel A`: „A preferuje vlak“ — individuální preference A, soukromá nebo výslovně sdílená.
- `subject=uživatel B`: „B preferuje auto“ — samostatná preference B; nikdy se automaticky nepřepíše preference A.
- `subject=rodina`: „Rodina preferuje společné výlety“ — pouze doložený nebo výslovně potvrzený společný kontext; neodvozovat z hlasu jediného člena.

Preference se mohou lišit podle situace, času a osoby. Konflikty neznamenají chybu dat: Lumi při společném plánování zvažuje jen preference, k nimž má aktér pro konkrétní účel oprávnění. Soukromé preference jiného člověka nesmí odhalit ani nepřímo („proto jsem tuto možnost vyřadil“).

## 4. Ingestace, návrhy a zveřejnění

1. Nové osobní údaje z vlastní konverzace, exportu, kalendáře či jiného osobního zdroje: **default Osobní/Nezařazeno**, jen po platném zdrojovém oprávnění. Nové sdílené neosobní kontextové poznatky mohou mít navrženou sdílenou Oblast, ale žádná soukromá evidence se tím nevydává.
2. Lumi může podle projektu, úkolu a Oblasti navrhnout subjekt a cílovou Oblast; **nepovažuje takový odhad za schválení**. Před přesunem nebo publikací soukromého claimu / shrnutí do Sdíleného ukáže přesný text, zdroje a konkrétní členy získávající přístup a vyžádá výslovné potvrzení vázané na platnou policy revizi.
3. Pro citlivá data, děti a informace třetích osob platí vyšší omezení a potřeba ověřit skutečné oprávnění osoby, nikoli pouhý souhlas osoby, která informaci vypráví. Pokud je právní či faktický podklad nedostatečný, sdílení se odmítne/fail-closed. Pozdější pravidla zákonného zástupce a dětských účtů jsou **otevřená produktová rozhodnutí**.
4. Odvozený claim, agregace, wiki stránka či souhrn vytvořený ze soukromého zdroje **nepřevádí** soukromé oprávnění do Sdíleného. Odvozenina musí respektovat průnik potřebných zdrojových práv a aktuální Area ACL; zveřejnit lze jen samostatně schválenou bezpečně redigovanou variantu s vlastním provenance záznamem.
5. Schválení subjektu nebo `review=confirmed` není souhlas se sdílením. Souhlas se zdrojem, souhlas s AI analýzou, schválení faktu a zveřejnění jsou **oddělená rozhodnutí**. Žádný export ani reálný import se tímto dokumentem neodemyká.
6. Změny členství, přístupu, mazání, odvolání souhlasu a návrat ze zálohy zachovávají přísné use-time revize, nezávislý durable witness a invalidaci odvozenin podle [H1 rozhodnutí](2026-11-08-humanwiki-knowledge-bootstrap.md). Dříve stažený externí soubor nelze spolehlivě odvolat.

## 5. Čtení, vyhledávání a odpovědi modelů

Každé API čtení, Context Resolver, fulltext/vector/embedding, autocomplete, vztahový graf, „Proč to vím?“, notifikace, cache, export a agentní nástroj musí používat **aktuální identitu, Area ACL, zdrojová omezení, revizi politiky a účel**. Nepřístupná znalost neprozradí ani svou existenci pomocí názvu, počtu, zpětného odkazu, rankingu, časové značky nebo negativního zdůvodnění odpovědi.

- Výstup v `Vše` je osobně sestavený autorizovaný pohled, **nikdy veřejný rodinný dump**.
- Při výměně identity, změně členství, revoke, logout nebo obnovení stavu se zneplatní výsledky, rychlé náhledy, kontext předávaný modelu, indexy a offline cache podle existujících bariér; nelze povolit late-response únik starého výsledku.
- Výslovné smazání znalosti zasahuje její přímo i nepřímo odvozené artefakty podle platného retenčního/revokačního kontraktu; neobnoví se potichu z historie.
- Autonomní publikování informace o někom jiném a automatické vytváření osobních profilů bez příslušného souhlasu jsou mimo rozsah.

## 6. UX HumanWiki

V existujícím **Více → Kontext / HumanWiki** a desktopovém kontextovém pohledu platí jediný globální čtecí přepínač `Vše / Osobní / Sdílené`. Není nová spodní mobilní záložka, prostor „Rodinné“ ani další paralelní filtr.

Stránky je možné procházet podle **Oblastí** a **subjektů** (Já, rodina, konkrétní člen, domácnost) v rámci právě povoleného rozsahu. Detail tvrzení zřetelně rozliší „o kom“, „kdo to řekl“, „kde a komu je dostupné“, „z čeho vychází“, aktuálnost a možnost opravy. Skutečné oprávnění nelze zaměnit za pouhý vizuální štítek.

Návrh ke sdílení je zřetelný a schvalovaný jako nová publikace; u citlivých tvrzení je možné nabídku vůbec nevytvořit. Přehled vždy ukazuje, že některé znalosti mohou být soukromé či nedostupné, **ale bez prozrazení jejich počtů nebo existence v cizím kontextu**.

## 7. Obsidian a externí Markdown

Obsidian je **volitelným prohlížečem/exportem**, nikoli autoritativní databází, povinným klientem nebo novým systémem práv. Stávající Obsidian-inspired UX v Lumi zůstává samostatně dostupné.

- **První fáze:** jednosměrný **read-only** export schválených a aktuálně oprávněných stránek do Markdownu s YAML frontmatter (stabilní neprůhledné ID, název, bezpečná metadata, povolené vztahy, datum aktualizace). Dvojcestný zápis je až pozdější samostatně schválený, autentizovaný a revizně hlídaný kontrakt.
- Fyzicky/přístupově odlišné úložiště nebo vault pro **soukromou paměť každého uživatele** a pro **každou sdílenou oblast / skupinu se skutečně shodným ACL**. Neslučovat Area s odlišným členstvím jen kvůli stejnému názvu „Rodina“.
- Export `Vše` může vzniknout pouze jako **osobní lokální agregovaný náhled adresáta** se stejnými oprávněními jako jeho čtení, nikdy jako rodinně sdílený vault.
- Před generováním filename, Markdown linku, backlinku, frontmatter, grafu a fulltextu probíhá serverová autorizace. Cizí neveřejné ID, odkazy, text, metadata ani nepřístupné zdrojové citace se neexportují.
- Opakovaná synchronizace musí bezpečně odstranit již neoprávněné položky z klienta, indexu i řízených exportů, ale **nemůže garantovat stažení dříve stažených/offline kopií**. Změna členství je proto prezentována jako dopad na budoucí přístup, ne jako zaručené odvolání dřívějších souborů.
- Žádná automatická synchronizace přes externí cloud, připojení Obsidian Sync ani publikování vaultu bez nového explicitního opt-in a revize přenosu.

## 8. Akceptace

| ID | Ověřitelný scénář |
|---|---|
| HW-FAM-01 | A uloží osobní preferenci ze svého soukromého chatu. Uživatel B ji nezíská dotazem, Context Resolvrem, hledáním, API ani exportem. |
| HW-FAM-02 | B uvede svoji preferenci v oprávněném sdíleném kontextu. Tvrzení má subjekt B; profil A ani společná preference rodiny se nezmění. |
| HW-FAM-03 | Sdílený projekt o dovolené navrhne Oblast; soukromá kalendářová poznámka nebo importovaný e-mail s ním související se **automaticky nesdílí**. |
| HW-FAM-04 | Rodinná společná preference vznikne pouze z oprávněných výroků/důkazů a správného subjektu, nikoli z jedné neověřené zmínky nebo AI shrnutí. |
| HW-FAM-05 | Citlivé informace o dítěti se bez samostatných ochranných pravidel nevydají a nejsou prozrazeny ani v souhrnu. |
| HW-FAM-06 | Po odebrání člena sdílené Oblasti selžou všechna nová čtení, hledání a exporty včetně stale-response, backlinks a embeddingů. Offline kopii nelze prohlásit za odstraněnou. |
| HW-FAM-07 | Publikace soukromé odvozeniny vyžaduje přesné preview obsahu/recipientů, zdrojové právo a potvrzení na platné policy revizi. Staré potvrzení neplatí po revokaci. |
| HW-FAM-08 | Markdown export uživatele A obsahuje jeho Osobní a aktuálně oprávněné Sdílené bez odkazů/počtů cizích neveřejných znalostí. Rodinný vault nikdy neobsahuje A soukromé poznámky. |
| HW-FAM-09 | Obě osobní preference A/B mohou být protichůdné; společné doporučení nepoužije soukromý údaj B, který B nezpřístupnil pro daný účel. |
| HW-FAM-10 | Zastavení zdroje, odvolání AI souhlasu, smazání znalosti a odebrání člena mají oddělené účinky včetně invalidace souvisejících odvozenin podle H1-real. |

Všechny scénáře vyžadují alespoň syntetické víceidentitní / víceoblasti testy s rozdílným členstvím a bezpečnostními negativními případy. Testy dokumentace samy neprokazují splnění produkčních bran.

## 9. Zavádění a otevřená rozhodnutí

1. **Model a autorizační kontrakt:** rozšířit Context Graph o explicitní subjekt + vztah k aktuální Area a provenance (bez paralelní DB), připravit výše uvedené akceptace.
2. **Osobní HumanWiki (H1/H2):** pouze po existujících use-time ACL, source-specific consent, review, witness/revoke a R3/R4. Nejprve owner-private import a čtení.
3. **Více identit a společná paměť:** až po ověřených multi-user Area, revokaci, oddělení preferencí a schválených publikacích. **Neobcházet pořadí současné H0–H4 roadmapy.**
4. **Obsidian:** nejprve omezený bezpečný read-only Markdown export, pak případně samostatně navržená obousměrná editace.

Otevřené pro budoucí samostatné rozhodnutí: účty dětí a oprávnění zákonných zástupců; kdo může souhlasit se sdílením údajů třetích osob; délka retence per-source; konkrétní API a synchronizační model pro Obsidian; sdílení souhrnných doporučení bez prozrazení chráněných vstupů. **Tento dokument sám žádnou z těchto výjimek neschvaluje.**
