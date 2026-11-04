# Rozhodnutí vlastníka Lumi: Prostory, Oblasti a Můj plán

- **Datum rozhodnutí:** 2026-10-23
- **Status produktu:** Schválený cílový koncept (neimplementováno)
- **Původ:** Produktová diskuse s vlastníkem Lumi dne 2026-10-23, navazující nezávislá revize Claudem a vypořádání připomínek [PR #101](https://github.com/Kocooour/AI-executive/pull/101)
- **Kontrakty:** [PRODUCT.md, LUMI-FR-013](../PRODUCT.md#lumi-fr-013), [UX-UI.md](../UX-UI.md), [ARCHITECTURE.md](../ARCHITECTURE.md)

## Schválené rozhodnutí

1. **Pouze dva datové prostory** z pohledu uživatele: **Osobní** a **Sdílený**. Technické interní workspaces nejsou uživatelským konceptem.
2. **Můj plán** je výchozí osobní agregovaný **rozsah dat**, nikoli třetí prostor nebo nová úvodní stránka. **Home / Denní brief** zůstává první obrazovkou.
3. **Oblast** je jednoduchý filtr/štítek a současně **přísná hranice viditelnosti**: soukromá Oblast patří uživateli, sdílená má výslovně určené členy. Oblasti nemají implicitně stejný obsah ani stejné členy.
4. Každý projekt má právě jednu Oblast. Každý úkol uvnitř projektu **povinně dědí** Oblast projektu; každý samostatný úkol má právě jednu vlastní Oblast. Bez výslovného zařazení platí bezpečný soukromý default **Nezařazeno**. AI může doporučit jinou Oblast, nikdy však sama zpřístupnit obsah.
5. Není potřeba vytvářet tématické dvojice Oblastí typu „Rodina – soukromá / Rodina – sdílená“. Například **projekt Rodina může být v soukromé Oblasti Osobní**.
6. **Můj plán** obsahuje moje soukromé úkoly a úkoly přiřazené mně ze sdílených Oblastí; Sdílené ukazuje i nepřidělené úkoly a práci jiných uživatelů, kterou smím vidět.
7. Lumi zůstává **osobním asistentem jednotlivce**; řízená spolupráce více lidí je doplňková schopnost, nikoliv systém monitorování lidí.
8. Před zveřejněním dat nebo změnou okruhu členů vyžaduje aplikace viditelné **explicitní potvrzení** a respektuje i ochranu poznámek, zdrojové pošty, historie, integrací a cache.

## Důsledky a hranice implementace

- Současná Lumi má pouze jednu skutečnou identitu, takže schválení konceptu **není souhlasem s předčasnou aktivací pozvánek**. Víceuživatelské sdílení je podmíněno serverovou autorizací, bezpečnou synchronizací, identitami, oddělením osobního stavu, správou historie/obsahu a obnovou.
- Cílové mapování sdílených Oblastí na samostatné interní workspaces vyžaduje **oddělenou auditovanou migraci** dnešních společných workspace dat; nemění uživatelský koncept dvou prostorů.
- Přechod nesmí z výchozího Mého plánu odstranit dosavadní práci vlastníka, i když legacy úkoly původně neměly řešitele.
- Revize Clauda v [komentáři k PR #101](https://github.com/Kocooour/AI-executive/pull/101#issuecomment-6369225912) identifikovala implementační výjimky (workspace migrace, legacy přiřazení, vlastnictví spoluautorského obsahu, osobní pole). Detailní bezpečnostní a migrační kontrakt je v ARCHITECTURE.md.

## Stav rozhodnutí a PR

Výše uvedený **funkční koncept byl vlastníkem schválen**. To samo o sobě **neautorizuje merge PR, nasazení ani změny runtime**. PR #101 slouží k nezávislému přezkumu dokumentace; sloučení musí stále splnit běžné kontroly a samostatný pokyn vlastníka.

## Dodatek 2026-10-26 — změna postupu implementace

Vlastník následně rozhodl, že současná data jsou převážně testovací a **zachování jejich historie nepodmiňuje další vývoj**. Preferuje [čistý start cílového modelu](2026-10-26-cisty-start-d3.md) podle [aktuální roadmapy](../ROADMAP.md) namísto komplikovaných legacy migrací 2a–2c. **Cílové funkční a bezpečnostní požadavky tohoto rozhodnutí zůstávají nezměněné**. Přechod na novou DB není autorizací k odstranění stávajících dat; vyžaduje novou explicitní autorizaci a zálohu. Původní požadavky na historickou migraci jsou nyní podmíněnou cestou pouze při zvolení zachování starých dat.

## Dodatek 2026-11-04 — globální rozsah Vše versus osobní Můj plán

Novější rozhodnutí vlastníka zpřesňuje dřívější slova „Můj plán jako výchozí rozsah“ bez změny dvou datových prostorů, příslušnosti k Oblastem a serverové autorizace:

- **Jediný globální přepínač celé aplikace** má hodnoty **Vše / Osobní / Sdílené**. **Vše** opravdu znamená všechna data, k nimž má přihlášený uživatel platné čtecí oprávnění: jeho soukromé položky a všechny oprávněné sdílené, včetně práce ostatních členů a nepřidělené práce. Neznamená třetí prostor ani neuděluje právo k zápisu.
- **Můj plán** je **samostatná výchozí mobilní obrazovka**, nikoli hodnota globálního filtru. Přehled dne i při zvoleném Vše obsahuje jen moje soukromé úkoly a mně přidělené aktivní sdílené úkoly; volba Osobní/Sdílené může tuto osobní podmnožinu pouze zúžit. Můj plán tedy neznamená totéž co globální Vše.
- **Projekty** a ostatní běžné pracovní seznamy používají jeden sdílený globální filtr, nikoli další lokální přepínač Vše. V Projektech zobrazuje **Vše všechny oprávněné projekty**, také ty sdílené, v nichž nemám přidělený úkol; Osobní pouze vlastní soukromé a Sdílené všechny oprávněné sdílené projekty.
- Zachovány jsou dvě uživatelské datové oblasti/prostory **Osobní** a **Sdílený**, právě jedna Oblast na projekt či samostatný úkol, dědění Oblasti v projektu, bezpečné soukromé Nezařazeno, explicitní souhlas se sdílením a skutečné serverové ACL. Filtr jednotlivé Oblasti vždy jen zužuje vybraný globální rozsah.
- Schválená mobilní navigace **Můj plán / Kalendář / Projekty / Více** a jednoduchý vizuální návrh Lumi Design v1.0 zůstávají nedotčené. Původní body tohoto dokumentu z 23. 10. jsou historickým rozhodnutím; **při interpretaci globálního výchozího rozsahu a mobilní úvodní obrazovky má tento novější dodatek přednost**. Realizace stále podléhá bezpečnostním a release branám.
