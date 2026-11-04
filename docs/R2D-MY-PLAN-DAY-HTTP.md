# R2d.3l.2 — výchozí vypnuté HTTP čtení denních úkolů Mého plánu

**Pouze izolovaný staging SQLite v21.** Samostatný
`GET /api/target-staging/task-temporal/my-plan-day`
zprostředkovává task-only denní pohled z
[R2d.3l.1](R2D-MY-PLAN-DAY-TASKS.md). Nevydává kalendářové
události, časové kapacity, pracovní bloky ani výsledky globálního
čtecího rozsahu **Vše**. Bez UI, produkčního nasazení, migrace,
resetu nebo zapnutí dalších účtů.

## Vypínací bariéry a parametry

Výchozí stav je **404**; endpoint vyžaduje současně explicitní
`AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED=true` a
`AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED=true`.
Totéž platí pro izolované čtecí dítě. Nepovoluje žádný zápis.

`GET` přijímá pouze:

- `areaFilter=all|personal|shared` (volitelný, výchozí `all`).
  Jde pouze o *zúžení aktérova Mého plánu*, nikoli všech
  dostupných sdílených úkolů.
- `window=today|upcoming` (povinný), povinné
  `evaluationDate=YYYY-MM-DD` z lokálního kalendářního dne
  uživatele; pro `upcoming` také povinné
  `throughDate=YYYY-MM-DD` (max. 90 dní). Pro `today`
  se `throughDate` neposílá.
- `limit=1..100` (výchozí 50) a volitelný opaque
  `cursor` délky nejvýše 4096 znaků. HTTP nesmí přijímat
  číselný offset ani identitu aktéra.

Všechny neznámé/duplicitní parametry jsou odmítnuty. Před
drahým read child je provedena živá staging restore/anchor,
identity/session admission a samostatný HTTP rate-limit.
Uživatel nikdy nepředává actor nebo Área oprávnění.

## Soukromí a konzistence

Krátkodobý, ohraničený Node child obdrží pouze **hash**
aktuální durable staging relace (ne bearer token). V ověřeném
preflightovaném read snapshotu čte kanonický SQL selector:
vlastní soukromé a **aktuálně přiřazené** sdílené úkoly
editor/admin, jejich vlastní `whenOn` a společný `dueOn`.
Úkol je jednou, patří do dne určeného **dřívějším** z obou
dat a nese obě původní data. Žádné neautorizované úkoly,
cizí uživatelské plány ani jiné assignee ID.

Parent parsuje **přesné allowlist DTO** včetně pořadí,
plánovacího dne, role v Oblasti, výskytu řádku, mezí a
vlastních soukromých revizí. Podpis kurzoru obsahuje
auth/session binding, restore generaci, vlastní Area filtr,
okno, oba datumy a limit. Pokračování je navíc podmíněno
nezměněným revision tokenem stránky.

**Silnější live-release bariéra než policy-only:**
před každou veřejnou odpovědí se v jedné čerstvé transakci
zkontrolují trvalá session/actor, kompletní množina
dostupných Oblastí Mého plánu, jejich policy, **content i
project-content epochy** a **současná soukromá epocha**
uživatele. Tím se zabrání úniku původně přiděleného
sdíleného úkolu po jeho přeřazení mezi snapshotem a
odpovědí. Stale výsledek vrací 409 bez dat. Selhání
preflightu či dítěte je 503; staré/neplatné session jsou
401 dle zavedeného staging kontraktu.

HTTP odpověď obsahuje pouze
`{tasks,hasMore,nextCursor,areaFilter,window,evaluationDate,throughDate}`,
kde jeden úkol nese identifikátor, název, rodičovský projekt,
efektivní Oblast, oddělené `dueOn`, vlastní `whenOn`
a `attentionOn`. Sdílené položky nesou jen
`assignedToMe:true`. `linearization`, actor ID,
vnitřní Area/epoch svědkové, revize, podpisové klíče a
cizí plán nejsou veřejnými daty.

## Testy a další kroky

`tests/target-staging-my-plan-day-http.test.mjs` ověřuje
dva výchozí flagy, neautentizované volání, striktní GET,
více uživatelů, diváka, projektové dědění, Area filtr,
soukromá data, seřazení, podepsané kurzory, ztracené
přiřazení po snapshotu, revokaci durable session a
negativní child DTO. Zařazeno do R2d cíleného CI.
Pro každý PR se vyžadují `PR Checks`; celá Browser E2E
sada až před produkčním deploymentem.

Další krok: samostatná kompozice s důvěryhodnými
kalendářovými událostmi, schválenými bloky, odhady a
čerstvostí; tento task-only endpoint nesmí tvrdit, že
uživatel má na daný den volnou kapacitu. Globální
serverově autorizované `Vše` zůstává separátním
kontraktem mimo Můj plán.
