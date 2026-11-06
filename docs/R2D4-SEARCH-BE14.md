# R2d.4b / BE-14 — víceslovné autorizované hledání podle názvu

**Stav:** implementovaný interní stagingový read model, nikoli veřejné HTTP vyhledávání ani produkční R3 aktivace. Navazuje na R2d.4a `lib/target-authorized-title-search.ts`.

## Nová schopnost

- Dotaz s 1–8 slovy vyhledá pouze položky, jejichž **vlastní název obsahuje všechna slova**, bez ohledu na pořadí nebo počet mezer. Například `project Shared` odpoví názvu `Shared empty project`. Jednoslovné hledání zůstává dosavadním podřetězcovým filtrem.
- Každé slovo se používá jako **doslovná** hodnota v SQL `LIKE` s escapováním `%`, `_` a `!`. Uživatelský text se neskládá do SQL: dynamická je jen posloupnost maximálně osmi pevných SQL predikátů `AND title LIKE ? ESCAPE '!'`; všechny hodnoty jsou vázané parametry.
- Všechna slova musí být v názvu **jedné** položky projektu, úkolu nebo poznámky. Nehledá se v obsahu poznámek, podřízených položkách ani v názvu cizího projektu. Stávající SQL Area/členství ACL běží před `LIMIT/OFFSET`; `Vše`, `Osobní` a `Sdílené` zůstávají odlišné.
- Dosavadní limity zůstávají: 2–80 znaků dotazu, 256 bajtů UTF-8, nejvýše 50 položek na stránku a offset nejvýše milion. Nový samostatný limit je **8 slov** (při více slovech bezpečně odmítnout). Předávání textu do cursoru ani HTTP endpoint se v tomto řezu nezavádí.
- Řazení je stále deterministicky podle binárního ID a typu; stránkování se provádí až nad kompletními autorizovanými výsledky. Revize stránky je nadále vázána na **přesný dotaz**, identitu, prostor, restore generation, všechny Area epochy včetně prázdných Oblastí i note-sync epochy. Různé pořadí slov vytváří odlišnou revizi, což je důležité pro budoucí cursor.
- SQLite používá vestavěnou ASCII-insensitive variantu `LIKE`; tato iterace **neslibuje** plnohodnotné jazykové skloňování, převody diakritiky ani Unicode case folding.

## Ověření a release hranice

`tests/target-authorized-title-search.test.mjs` pokrývá pořadí slov, neadjacentní shodu, doslovné wildcards, zachování SQL ACL, zákaz cizích titulů, oddělení tří rozsahů, limit osmi slov, deterministické stránky a revizi svázanou s přesným dotazem. Stávající testy potvrzují atomické read preflight a živé oprávnění/epochy před uvolněním dat.

**Zůstává mimo:** HTTP adapter, podepsané stránkování na veřejné hranici, indexace obsahu, AI hledání, autocomplete, UI, produkční nasazení, migrace či přepnutí funkcí. Případné HTTP zpřístupnění musí teprve dodat actor/session-bound preflight, podprocesové čtení, přísné ověření DTO a atomický live-release guard včetně note-sync epoch; nikdy nevydávat přímo interní stránky se svědectvími oprávnění.
