# UI-04c — Můj plán: Dnes/Zítra a Oblasti (vývojový náhled)

**Závislost:** UI-T, UI-04b (sloučeno v #256). **Režim:** pouze `NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW=1` a aktivní karta `MyPlanPreview`/Můj plán. Otevření původního `?view=Today`, ostatních seznamů nebo vypnutí příznaku zachovává legacy rozhraní a chování.

## Rozsah

- **Dnes:** otevřené úkoly naplánované dnes nebo dříve, s příznakem `today`, nebo s **termínem dnes či po termínu** (i pokud je jejich `when` naplánováno později).
- **Zítra:** otevřené úkoly s datem `when` nebo termínem zítra, pokud již nepatří do Dnes. Dokončené úkoly ani další vzdálená data se nepřidávají. Položka se zobrazí v nejvýše jednom oddílu.
- Úkoly jsou seskupené do **pastelových bloků Oblastí bez viditelných nadpisů**. Názvy existují jako přístupná označení skupiny. Oblast Osobní používá zelený token, Práce modrý; kontura dokončení/pozornosti se od oblasti neodvozuje. Nezařazené úkoly mají neutrální blok.
- Oblast projektového úkolu se vyhodnocuje ze **stejného workspace** přes `belongs_to_project` a teprve poté přes `belongs_to_area`. Zastaralý přímý odkaz na Oblast u úkolu v projektu nemůže změnit dědičnost. Konfliktní vazby končí v nezařazené skupině. Ignorují se vazby na jiný prostor, neaktivní Oblasti a legacy vlastnosti `areaId`/`projectId`.
- Kalendářní události dnes zůstávají ve stávajícím interaktivním timeline, ale dostávají jednoduchou značku `▦` (včetně celodenních). Úkol již vykreslený jako položka timeline se v Dnes neopakuje.
- Existující návrh ze shrnutí dne má viditelný štítek **✦ Návrh Lumi**, tlačítko **Posoudit**, text popisující dopad a až poté explicitní **Schválit/Odmítnout**. V náhledu se návrh vybírá výhradně ze **skutečně viditelných, filtrovaných a netimelinových úkolů v Dnes**; počet pro posouzení přetížení odpovídá stejným řádkům. Úkoly po termínu se započítávají do zatížení, ale ochrana termínu brání jejich automatickému odkladu. Schválení platí jen pro přesnou verzi úkolu a obsahu doporučení (důvod, parametry, cíl); po změně je nutné znovu Posoudit. Před zápisem se v transakci ověřuje poslední lokální verze, při nesouladu se nic nezapíše a uživatel dostane hlášení. Vypnutí náhledu zachová původní akce.
- Ovládání dokončení a přístupné 44px plochy jsou převzaté z UI-04b. Řazení vyžaduje vstup do režimu úprav a **klávesnice i dotykové / HTML drag-and-drop vybírají sousedy pouze z viditelného oddílu dne a stejné zděděné Oblasti**; deadline-only úkoly v Dnes a zítřejší úkoly se řadí stejně jako jiné viditelné položky. Přesun mezi dny, Oblastmi, skrytými položkami nebo do legacy sekce je v náhledu blokován, nikoli fallback na původní Today/Upcoming seznam. Datum, prostor a vazby se pouhým řazením nemění. Zítra nepoužívá Today time cell ani rychlé odložení.

## Hranice oprávnění a dat

Tohle **není** serverově autorizovaný osobní souhrn přes oba prostory. Používá pouze legacy lokální záznamy právě vybraného prostoru, s kontrolou `workspaceId` u úkolů i vazeb. V legacy agregovaném `all` se žádná skupina nevykreslí — je zobrazeno vysvětlení, že je třeba vybrat jeden prostor. Cílový globální Můj plán musí dodat R3-slice: identita, serverově povolené úkoly ze soukromého i sdíleného prostoru, pending/offline, konflikty a revokace. UI-04c nemění cílovou databázi, backend ACL ani produkční režim.

Dnešní kalendář a horní část plánu zůstávají legacy. Technické údaje v Kalendáři řeší UI-04d, celkové desktop rozložení UI-03. Produkční cutover vyžaduje samostatný výslovný souhlas a release gates UI-09/R4 včetně browser E2E.

## Kontroly

`tests/my-plan-preview-ui04c.test.mjs` ověřuje hranice Dnes/Zítra, rok/přestupný den, prioritní filtr a řazení, neduplikování, dědění, konfliktní a cizí vazby, `all` fail-closed a opt-in propojení. PR Checks na přesném head provádí typecheck, cílené unit testy a produkční build; kompletní browser E2E se provádí až v release gate.
