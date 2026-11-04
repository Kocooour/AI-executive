# R2d.3l.1 — task-only denní množiny pro Můj plán

Tato iterace skládá **dva různé druhy data** v izolovaném
staging SQLite v21: sdílený deadline `tasks.due_on` a soukromý
plánovaný den `personal_task_plans.when_on`. Nejde o plné
obrazovky Today/Nadcházející: kalendářové události, schválené
pracovní bloky, kapacity, Inbox a UI se zde ještě neřeší.
Žádné HTTP, migrace, produkční aktivace ani změna legacy dat.

## Kontrakt

`readAuthorizedMyPlanDayTaskPage(db, request)` je nízkoúrovňový
selektor; jeho důvěryhodný vstup musí pocházet z kanonicky
preflightovaného, autentizovaného připnutého snapshotu.
`readPreflightedMyPlanDayTaskPage` vynucuje tuto bránu a
`TargetStagingSessionAuthority.readMyPlanDayTaskPage` vytváří
podepsanou interní čtecí identitu.

- `window: today|upcoming`: datum určuje **volající** v místním
  kalendářním dni uživatele, nikoli UTC server;
  datumy mají striktní podobu `YYYY-MM-DD`.
- `today`: datum prvního upozornění `<= evaluationDate`
  (zahrnuje po termínu a z minulosti nevyřízené plánované dny);
  `throughDate=null`.
- `upcoming`: `evaluationDate < attentionOn <= throughDate`,
  délka dopředného okna 1–90 dní.
- `attentionOn`: **dřívější** z osobního `whenOn` a sdíleného
  `dueOn`; je-li jeden prázdný, používá se druhý.
  Jeden úkol se ve stejném seznamu zobrazí nejvýše jednou a
  nemůže být schován budoucím osobním plánem, pokud již
  nastal jeho deadline. Obě původní datumy se uchovávají odděleně.
- `areaFilter: all|personal|shared` je **průnik nad Mým plánem**,
  nikoli globální seznam `Vše` všech dostupných úkolů. Ani
  `all` nepřidá nepřiřazenou nebo někomu jinému přiřazenou
  sdílenou práci; globální `Vše` zůstává odděleným kontraktem.
- SQL nejprve ověří aktuální soukromou Oblast vlastněnou aktérem,
  nebo sdílenou Oblast s rolí editor/admin a **současným**
  řešitelstvím aktéra. Projektové úkoly dědí Oblast.
  `viewer`, cizí soukromé a nepřidělené sdílené úkoly se
  nezobrazí ani přes počet nebo listování.
- Jen `open` úkoly. Řazení `attentionOn ASC,taskId BINARY ASC`;
  SQL `LIMIT limit+1 OFFSET offset`, limit 1–100 a offset nejvýš
  1 000 000. Offset je interní, žádný veřejný cursor nevzniká.

Výsledek obsahuje task ID, název, rodiče, efektivní Area
a druh, sdílený `dueOn`, **jen aktérovo** `whenOn`,
a `attentionOn`. U sdílených úkolů pouze `assignedToMe:true`;
nikdy identifikátor jiného řešitele. Pro budoucí adaptér je
serverově interně připojená `linearization` (všechny
oprávněné, i prázdné Oblasti) a `privateEpoch` — **nesmějí
se posílat klientům**.

Revize stránky zahrnuje staging restore generation,
aktéra, Area filtr, okno a datumy, osobní epoch aktéra,
a policy+content epochy všech jeho přispívajících Oblastí.
Plánování jiného člověka nemění soukromou epochu aktéra;
změny sdílených úkolů mohou revidovat Area obsah.
Jakýkoli budoucí HTTP adaptér musí před vydáním výsledku
ověřit **LIVE** session, Area policy a actor-private epoch
na aktuálním store, zamezit stale stránkování a podepsat
actor/session-bound cursor. Nesmí sestavovat výsledek
sloučením dvou separátních, různě autorizovaných HTTP stránek.

## Testy a navazující práce

`tests/target-my-plan-day-task-read.test.mjs` pokrývá
dvě datumová pole, deduplikaci a rozdělení today/upcoming,
data po termínu, aktuální přiřazení, project inheritance,
viewer/cizí soukromá data, vlastní Area filtry, SQL stránkování,
striktní datumy, Actor-only revision, trvalou relaci a revokaci.
Testy jsou v cíleném R2d workflow.

**R2d.3l.2:** samostatně výchozí vypnuté HTTP čtení
s podepsaným cursorem, live soukromou epochou a Area guardem.
Teprve následně se rozšíří kompozice na události, schválené
bloky, odhady a dostupnost kalendáře podle produktového UX.
Úkolové datum není tvrzením, že má uživatel v kalendáři volno.
Browser E2E patří na release gate před produkční nasazení.
