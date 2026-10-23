# Lumi — UX/UI specifikace

> **Závazný dokument pro informační architekturu, obrazovky, interakce a přístupnost.** Základní revize 14. 10. 2026; cílová změna prostorů, Oblastí a Mého plánu schválena 23. 10. 2026. [Rozcestník](../README.md) · [Produkt](PRODUCT.md) · [Architektura](ARCHITECTURE.md). Následující obrazovky jsou cílovým produktem, nikoli všechny již hotovým UI.

## UX přehled

Lumi není „task manager s AI navíc“: první otázka Home je **„Co dnes potřebuje moji pozornost?“**. Denní brief ukazuje konkrétní důvody, časovou aktuálnost a doporučené další kroky. Pracovní seznamy zůstávají k dispozici, ale nejsou jediným mentálním modelem uživatele.

Na desktopu je globálně dostupný Lumi Chat, levý sidebar pro navigaci a podle potřeby pravý inspektor; mobil používá bottom navigation a celoplošné/spodní sheets. Hlas i chat podléhají stejnému schvalování jako běžné klikání.

## Index obrazovek a propojení na produktové požadavky

| ID | Cílová obrazovka / plocha | Priorita | Funkční požadavky |
|---|---|---|---|
| **LUMI-UX-001** | Home / Denní brief | P0 | LUMI-FR-003, 004 |
| **LUMI-UX-002** | Lumi Chat | P1 | LUMI-FR-006, 005 |
| **LUMI-UX-003** | Návrh → schválení → akce | P0 | LUMI-FR-005, 011 |
| **LUMI-UX-004** | Desktop Calendar | P1 | LUMI-FR-004 |
| **LUMI-UX-005** | Detail projektu | P0 | LUMI-FR-001, 007 |
| **LUMI-UX-006** | Inbox | P0 | LUMI-FR-002 |
| **LUMI-UX-007** | Notes a meeting context | P1 | LUMI-FR-007 |
| **LUMI-UX-008** | Global search | P1 | LUMI-FR-008, 011 |
| **LUMI-UX-009** | iPhone Home | P0 | LUMI-FR-003, 010 |
| **LUMI-UX-010** | Mobile capture (text / hlas) | P0 text / P2 hlas | LUMI-FR-002, 012 |
| **LUMI-UX-011** | Mobile approval | P0 | LUMI-FR-005 |
| **LUMI-UX-012** | Mobile Today | P0 | LUMI-FR-004, 010 |
| **LUMI-UX-013** | Mobile Calendar | P1 | LUMI-FR-004 |
| **LUMI-UX-014** | Proaktivní oznámení | P2 | LUMI-FR-009 |
| **LUMI-UX-015** | Voice interaction | P2 | LUMI-FR-012 |

## Testování a interakční pravidla

- Každá obrazovka musí projít **vlastními akceptačními kritérii v následující tabulce** i společnými zásadami bezpečnosti a přístupnosti.
- Návrh a potvrzený stav jsou vizuálně rozlišitelné. Po provedení je vidět výsledek a případné bezpečné Undo; expirovaná či konfliktní schválení nesmějí projít.
- Testují se desktop a iPhone, klávesnice/VoiceOver, malá šířka a větší text, načítání, prázdný stav, výpadek sítě, pending sync, konflikt, ztráta oprávnění a přepnutí workspace.
- Aktuální omezení a výjimky se neskrývají za „hotovým“ obrázkem cílového stavu. [Technický stav](ARCHITECTURE.md#current-mvp) a [produktové milníky](PRODUCT.md#shipped-foundation-and-phased-delivery) jsou závazné pro označení shipped/target.

---

## Můj plán, Osobní, Sdílené a Oblasti — cílové UX (rozhodnutí 2026-10-23)

Tato kapitola konkretizuje [LUMI-FR-013](PRODUCT.md) a má v cílovém stavu přednost před starším mentálním modelem libovolných workspaces / „All my work“. **Nejde o tvrzení, že víceuživatelské funkce jsou již dodány.** Zachovává se schválené pořadí desktopové navigace a mobilní bottom nav z 22. 10. 2026.

- **Výchozí obrazovka je Home / Denní brief**, nikoli samostatná stránka „Můj plán“. Můj plán je výchozí **rozsah dat** pro Home, Inbox, Today, Upcoming, Projects a související pracovní filtry. Přepínač rozsahu má právě tři hodnoty **Můj plán / Osobní / Sdílené**; v datovém modelu však existují pouze dva prostory **Osobní** a **Sdílený**. Volba nemění uživatelskou identitu, vlastníka záznamů ani oprávnění.
- **Můj plán** zobrazuje moje soukromé úkoly a úkoly přidělené mně ze sdílených Oblastí; **Osobní** zobrazuje veškeré moje soukromé projekty a úkoly; **Sdílené** zobrazuje všechny dostupné společné projekty a úkoly, včetně nepřidělených a úkolů ostatních. Sdílená práce se ve výchozím plánu nemíchá s neadresovanými úkoly jiných členů. V Projects v rozsahu Můj plán se ukazují soukromé projekty a sdílené projekty s alespoň jedním mně přiděleným aktivním úkolem; otevření sdíleného projektu zobrazuje všechny jeho oprávněné úkoly. Identická položka má ve všech pohledech stejné ID a revizi.
- **Oblast** je jednoduchý filtr a štítek každého projektu / samostatného úkolu; u úkolů v projektu se zobrazuje zděděná Oblast projektu. Filtry Oblastí jsou dostupné napříč projekty i dalšími relevantními pohledy a respektují aktuální rozsah. Oblast je vždy soukromá nebo sdílená s konkrétními členy; v UI musí být tato skutečnost čitelná textem i ikonou, nejen barvou. Sdílená Oblast se zobrazí pouze oprávněným členům. Soukromá Oblast může obsahovat například projekt **Rodina**; nevynucuje se dvojice podobně pojmenovaných Oblastí.
- **Quick Capture / nová položka** ukazuje před uložením cílovou Oblast (i když byla bezpečně předvyplněna jako soukromá **Nezařazeno**). Inbox zůstává stavem třídění, nikoli Oblastí. Při vytváření úkolu uvnitř projektu je jeho Oblast zobrazená jako zděděná a nelze ji nezávisle měnit. AI může nabídnout jinou Oblast, ale u sdílené volby zobrazí členy, kterým bude obsah dostupný, a vyžádá explicitní souhlas.
- **Sdílení a přesun**: při přesunu nebo změně typu Oblasti ukáže modal/sheet stávající a cílovou Oblast, uživatele získávající/ztrácející přístup, počet dotčených projektů/úkolů/poznámek a budoucích příloh, dopad na přiřazené úkoly, pravidlo historie (revize před zveřejněním zůstávají soukromé) a jasné Schválit / Zrušit. Potvrzení platí i při **zúžení** přístupu. Při konfliktní či zastaralé revizi se nic nezmění a zobrazí se nový návrh.
- **Vlastník a řešitel** jsou různé role; na sdílených položkách se ukáže Oblast a příslušný řešitel (nebo „Nepřiděleno“), případně vlastník. Nepřidělený sdílený úkol je vidět v Sdílené a správce jej může rozdělit, ale neobjeví se automaticky v osobních plánech všech členů. Soukromý úkol nelze přiřadit někomu jinému. Přijetí dnešního bloku, plánovaný den, osobní odložení/odmítnutí attention položky a soukromé připomínky jsou vidět jen příslušnému uživateli; sdílený deadline a stav zůstávají společné.
- **Ztráta oprávnění a offline**: UI při příštím spojení odstraní revokovaný obsah z kanonické cache, hledání, odvozených náhledů a připomínek, zablokuje staré zápisy a poctivě sdělí, že dříve stažené/offline kopie nelze vzdáleně vzít zpět. Odhlášení a přepnutí uživatele nesmí zobrazit obsah předchozí identity; přepnutí rozsahu nesmí zobrazit zakázané výsledky ani v počtu, autocomplete či notifikaci.
- **AI a poštovní zdroje**: uložit do Sdílené výňatek z osobního e-mailu, kalendáře nebo citlivé poznámky je nové zveřejnění. Návrh před potvrzením ukáže přesný zveřejněný úryvek a příjemce; nikdy se bez potvrzení nevloží zdrojový obsah jen proto, že souvisí se sdíleným projektem. Rozsah zápisu určuje cílová Oblast, ne to, zda byl otevřen Můj plán.

**UX akceptace:** desktop i iPhone zvládnou změnit rozsah bez ztráty kontextu; Home zůstává start; nový samostatný úkol je soukromý; úkol uvnitř projektu dědí Oblast; obě směrové změny viditelnosti jsou výslovně schvalované; sdílené nepřidělené úkoly jsou dohledatelné; jedno snooze uživatele nepřepíše stav jiného; při odvolání oprávnění nepřetrvají náhledy ani soukromé názvy. Testovat klávesnici, VoiceOver, úzkou obrazovku, offline konflikt a prázdné stavy. Vzhled ani nasazení nové funkce tento specifikační dokument samy o sobě nemění.

## UX/UI cílového produktu — target requirement

Tato kapitola popisuje cílovou zkušenost a její ověřitelná kritéria, nikoli stav již dodaných obrazovek. P0 je nezbytný základ každodenní práce, P1 rozšiřuje plánování a kontext, P2 přidává pokročilé vstupy a proaktivitu. Priority označují pořadí dodání obrazovky; každá obrazovka musí současně dodržet pravidla přístupu, čerstvosti, schvalování a dostupnosti uvedená v této specifikaci. Produktové texty používají **Lumi**; stabilní technické názvy a integrační cesty se kvůli kompatibilitě nepřejmenovávají.

**Informační architektura a navigace.** Desktop má trvalý levý sidebar v pořadí **Home, Inbox, Today, Upcoming, Projects, Calendar** (rozhodnutí vlastníka 2026-10-22, [návrh](proposals/2026-10-zjednoduseni-ui.md#51-navigace)). Areas jsou skupinami v seznamu Projects; samostatný pohled Areas je v sekundární navigaci. Pošta (připojené účty) je v Inboxu jako zdroj „Z pošty“; v nastavení zůstává jen připojení účtu. **Notes a Search** nejsou v primárním sidebaru: Search je globální (topbar, ⌘K), Notes jsou dostupné přes ⌘K a sekundární navigaci. Přepínač **Můj plán / Osobní / Sdílené** je viditelný nad navigací; jde o rozsah dat, nikoli o novou obrazovku či cílový workspace. Oblasti jsou filtry, nikoliv další přepínané prostory. Lumi Chat je dostupný globálním ovládacím prvkem a klávesovou zkratkou bez ztráty rozepsané práce. Méně používané filtry (Overdue, Anytime, Someday, Completed), nastavení, historie, Context review a technické Agents jsou v kontextových filtrech, sekundární navigaci nebo nastavení, ne v primárním sidebaru. Search je zároveň rychle vyvolatelný odkudkoli. Na desktopu používají Inbox, Today, Projects, Notes a Search podle potřeby **3-pane pattern**: vlevo navigace, uprostřed seznam či výsledky, vpravo detail/inspektor s původem dat, vztahy a bezpečnými akcemi. Home a Calendar mohou pro přehled použít širší hlavní plochu a kontextový pravý panel. Šířka panelů se přizpůsobí oknu; při zúžení se detail otevře jako samostatný pohled.

Na iPhonu je základní **bottom nav Home, Inbox, Today, Projects, Více** (rozhodnutí vlastníka 2026-10-22), s přístupem ke Calendar, Areas, Notes a Search přes přehled „Více“ nebo globální hledání; přepínač **Můj plán / Osobní / Sdílené** je dostupný i na mobilu bez skrytí aktuálního pohledu; dnešní události jsou vidět i v Today. Quick Capture je trvale dosažitelné jedním klepnutím. Detail, filtr, návrh změny a chat používají celoplošné nebo spodní sheets s jasným zavřením a zachováním rozepsaného obsahu. Gesta nejsou jedinou cestou k akci; schválení vyžaduje zřetelné tlačítko. Mobilní návrh zachovává význam, zdroj, stav a kontrolu nad akcemi i při menším prostoru.

**Hlavní tok:** Remember zachytí úkol, poznámku, schůzku či podklad do Inboxu a propojí jej s kanonickým modelem; Attention jej vyhodnotí a stručně vysvětlí na Home; Plan nabídne pořadí práce a případný časový blok v kontextu kalendáře; Act zobrazí přesný návrh změny, vyžádá schválení a po provedení zpřístupní výsledek, audit a bezpečné Undo. Chat, hlas a notifikace jsou vstupy do téhož toku, nikoli samostatné zdroje pravdy či cesty kolem schválení. Z Home lze otevřít důkaz, upravit plán, přejít na související projekt a vrátit se bez ztráty kontextu.

| Obrazovka / role | Priorita | Acceptance criteria |
|---|---|---|
| **Home / Denní brief** — hlavní attention surface a návrh dne (Attention → Plan) | P0 | Ukáže dnešní závazky, dostupnou kapacitu jen z čerstvého kalendáře, nejvýše pět zdůvodněných doporučených akcí a další kandidáty na vyžádání. Každá karta má důvod, zdroj, čas vyhodnocení, otevření detailu a vhodné snooze/dismiss; prázdný stav nevyrábí naléhavost. Návrh dne rozlišuje potvrzené bloky od návrhů. |
| **Lumi Chat** — univerzální konverzační ovládací vrstva (Remember → Act) | P1 | Umí vyhledat a vysvětlit relevantní práci, zachytit vstup a připravit stejný návrh jako UI v oprávněném čtecím rozsahu; každý návrh zápisu má jednu viditelnou cílovou Oblast. Odpověď odkazuje na oprávněné zdroje a přizná nejistotu; změna se provede až po shodném schválení, chat nikdy neoznačí návrh za hotovou akci. |
| **Proposal → Approval → Action** — kontrola dopadu (Act) | P0 | Před schválením ukáže cíl, cílovou Oblast a její okruh oprávněných členů, interní bezpečnostní rozsah, hodnoty před/po, související položky, dopad na kalendář či jiné systémy, nevratné vedlejší účinky a případné konflikty. Schválení je konkrétní; úspěch zobrazí výsledek, audit a Undo jen tam, kde je bezpečné. Expirovaný či zastaralý návrh se neprovede a nabídne nové posouzení. |
| **Calendar planning in context** — kapacita vedle práce (Plan) | P1 | Zobrazuje události, potvrzené pracovní bloky a návrhy odděleně; návrh bloku uvádí úkol, trvání, důvod, zdroj dostupnosti a konflikt. Přijetí znovu ověří revizi i překryv a nemění deadline úkolu. Při odpojeném či zastaralém kalendáři nenabízí přesný volný čas. |
| **Project detail** — strukturovaná pracovní paměť (Remember → Attention) | P0 | Ukáže výsledek/cíl, stav, další akci, úkoly, související poznámky, osoby a potvrzené vztahy, čas poslední relevantní aktivity a vysvětlená rizika. Editace má viditelné ukládání a historii; chybějící další akce je vysvětlený attention kandidát, ne automatické selhání projektu. |
| **Inbox** — rychlé zachycení a triage více typů vstupů (Remember) | P0 | Přijme krátký úkol, myšlenku, odkaz a vložený text schůzky či e-mailu jako rozlišitelné vstupy. Ukáže originál a editovatelné návrhy; uživatel může vyjasnit, naplánovat, přiřadit, označit čekání, odložit či zahodit. Extrakce sama nepotvrdí tvrzení, osobu ani úkol; čekající synchronizace je viditelná. |
| **Notes / meeting context** — souvislosti a akční body (Remember → Act) | P1 | Poznámka ke schůzce ukáže původ, datum, účastníky jen při potvrzené identitě, vztahy na projekty/úkoly a editovatelné akční body. Akční bod se stane úkolem až po vědomém převzetí; sporné či neověřené vztahy zůstávají označené a kontrolovatelné. |
| **Global search** — nalezení práce a zdrojů (Remember) | P1 | Hledá v oprávněných úkolech, projektech, poznámkách a lidech; po připojení a indexaci také v souborech a e-mailech. Výsledek uvádí typ, workspace, zdroj a datum/čerstvost; filtry umožní zúžení a otevření kontextu. Nedostupný zdroj je přiznaný a neoprávněný obsah se neobjeví ani v náhledu či počtu. |
| **iPhone Home** — kapesní brief (Attention) | P0 | První obrazovka ukáže hlavní doporučení, dnešní plán a stav dat v čitelných kartách; z každé karty vede přímá cesta na detail nebo bezpečnou akci. Bez scrollování přes rozsáhlé seznamy je dostupné Quick Capture a dnešní práce. |
| **Mobile quick capture včetně hlasu** — zachycení v pohybu (Remember) | P0 pro text, P2 pro hlas | Text je dosažitelný jedním klepnutím a zachová rozepsaný vstup. Hlasový záznam vyžaduje svolení, nabídne přepis k opravě před uložením a jasně ukáže neúspěch přepisu; bez připojení nebo oprávnění zůstává textová cesta. Ani přepis sám nevytvoří potvrzený závazek. |
| **Mobile approval** — rozhodnutí v kontextu (Act) | P0 | Sheet ukáže stejné před/po, workspace, souvislosti a vedlejší účinky jako desktop; delší dopad lze rozbalit bez ztráty kritických údajů. Schválit a odmítnout mají samostatné dostupné ovladače; konfliktní či expirovaný návrh se nedá schválit. |
| **Mobile Today** — proveditelný dnešek (Plan → Act) | P0 | Oddělí pevné závazky, přijaté bloky a navržené úkoly; ukáže odhad a důvod pořadí, pokud jsou známy. Dokončení úkolu aktualizuje kanonický stav; offline změna má viditelný stav čekání/synchronizace/konfliktu. |
| **Mobile Calendar** — plán v čase (Plan) | P1 | Denní a blízký přehled dovolí otevřít událost, úkol i návrh bloku a vrátit se do Today. Konflikty a zastaralý/odpojený zdroj jsou viditelné; přijetí bloku jde přes revizně kontrolované schválení. |
| **Proactive notifications** — návrat k podstatnému (Attention) | P2 | Oznámení sděluje stručný důvod a vede na konkrétní Home položku či návrh bez automatické akce. Respektuje oprávnění, quiet hours, limity, snooze, deduplikaci a workspace; při nedoručení Lumi netvrdí opak. Obsah na zamčené obrazovce neprozrazuje chráněný kontext; název úkolu a důvod se podle rozhodnutí vlastníka (2026-10-07) zobrazují. |
| **Voice interaction** — konverzační vstup a odpověď (Remember → Act) | P2 | Uživatel vědomě spustí poslech, vidí stav nahrávání a může jej zastavit. Přepis a rozpoznaný záměr lze před odesláním opravit; odpověď uvádí zdroje/nejistotu a návrh změny přechází na běžnou approval obrazovku. Chyba oprávnění, sítě nebo rozpoznání nabízí textovou alternativu. |

**Společné UX principy a stavy.** Attention-first řazení ukazuje důvod a doporučený další krok před úplným seznamem, ale ponechává přístup ke všem kanonickým záznamům. Explainability zahrnuje zdroj, pravidlo či důvod, nejistotu a rozdíl mezi návrhem a potvrzeným stavem. U každé upravitelné plochy jsou viditelné stavy ukládání, uloženo, čeká na synchronizaci, konflikt a chyba; u odvozených doporučení také čerstvost dat a čas vyhodnocení. Loading stav zachovává kontext a nevypadá jako potvrzený prázdný výsledek. Offline PWA umožňuje dostupné čtení a zachycení s jasným omezením živého kalendáře, agentů a doručení. Mac podporuje klávesnici, viditelný focus a předvídatelné zkratky; iPhone má dostatečně velké dotykové cíle, bezpečné oblasti a ovládání bez povinných gest. Sémantické popisky, kontrast, dynamická velikost textu, čtečka obrazovky a omezený pohyb jsou součástí acceptance kritérií všech priorit. Přepnutí workspace či odhlášení nesmí odhalit dříve zobrazená soukromá data v cache, výsledcích ani návrzích.

---

## Sémantické hledání a Context Graph — cílové UX (varianta C)

Tato kapitola rozšiřuje obrazovky Notes, Project detail a Global search; review je jejich kontextový panel otevřený z výsledku, detailu nebo grafu, nikoli nová primární obrazovka. Neoznačuje je za dodané. Uživatel hledá význam, ale vždy vidí, co Lumi skutečně našla a proč.

- Online Search nabízí přesné a serverově sémantické výsledky ve stejném oprávněném workspace. Každá položka má typ, workspace, zdroj/locator, čerstvost a jeden jasný štítek: Potvrzené tvrzení, Odkaz v poznámce nebo Podobný obsah. Skóre podobnosti se uživateli nevydává za důvěryhodnost.
- Detail výsledku vede na kanonickou položku a její konkrétní úsek, ukáže provenance/evidence a umožní otevřít oprávněné sousedy grafu. Neexistující, nejednoznačný či nepřístupný wikilink se zobrazuje jako bezpečný text/návrh opravy, ne jako skrytě vytvořená relace.
- Graf rozlišuje vzhledem i textem claimovou relaci, dokumentární odkaz a similarity; pouze claimová relace ukazuje review stav a evidence. Filtry pro druh vztahu, stav, workspace a čerstvost nesmějí rozšířit oprávnění.
- Stav serverového indexu je srozumitelný: připraveno, indexuji změny, výsledky mohou být neúplné nebo sémantické hledání není dostupné. Offline PWA hledá jen lexikálně v již synchronizovaných kanonických datech a označí je jako neúplný lokální výřez; jejich dosavadní offline čtení a čekající změny zůstávají dostupné. Přesné hledání zůstává nabídnuto. UI nikdy neslibuje, že nic dalšího neexistuje, pokud index není aktuální nebo uživatel nemá přístup.
- Mobilní detail zachová štítek významu, citaci a zdroj před zkráceným náhledem; propojený obsah se otevírá přes standardní sheet. Přepnutí workspace/odhlášení odstraní odvozené výsledky a úryvky podle policy; na klientovi není vektorový index. Stávající offline čtení uložených kanonických dat řídí dosavadní sync kontrakt.

Akceptace: český online dotaz s odlišnou formulací lze ověřit otevřením přesné citace; podobný výsledek nevytváří claim ani úkol; nepřístupná položka se neobjeví v seznamu, počtu, autocomplete ani při chybě a neodhalí existenci cíle wikilinku; confidential i restricted obsah se standardně nevydává externímu poskytovateli ani MCP; offline zůstanou čitelná uložená kanonická data a funguje jen lexikální lokální hledání; po změně zdroje UI nepředstírá čerstvost; graf a Search jsou klávesnicí i čtečkou ovladatelné a stav nesdělují jen barvou.
