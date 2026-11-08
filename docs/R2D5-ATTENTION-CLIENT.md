# R2d.5e — identitně vázaný paměťový klient Attention s invalidací cache

**Pouze staging, výchozí neaktivní, bez UI, serverových změn a persistence.**
Přidává typovaný transport a řadič relace nad
[R2D5-ATTENTION-HTTP.md](R2D5-ATTENTION-HTTP.md) a
[R2D5-ATTENTION-COMMAND-HTTP.md](R2D5-ATTENTION-COMMAND-HTTP.md). Žádná komponenta
je zatím neimportuje. Nepoužívá IndexedDB, `localStorage`, `sessionStorage` ani
Cache API; veškerý stav žije jen v paměti objektu relace.

## Transport — `lib/target-staging-attention-client.ts`

- `fetchAttentionPage`, `fetchAttentionCommandPreview`, `sendAttentionCommand`
  (PATCH), `fetchAttentionCommandReceipt` (POST). Vše `same-origin`,
  `credentials:"same-origin"`, `cache:"no-store"`, `redirect:"error"`.
  PATCH/POST posílají `x-lumi-target-protocol: 1` a přesně dvanáctipolní příkaz
  (pole se znovu skládají jednotlivě, nic navíc neodejde). `Origin` doplní prohlížeč.
- Tělo odpovědi je omezené (stránka 2 MiB, ostatní 16 KiB), vyžaduje `no-store`,
  `application/json`, žádné přesměrování a striktní UTF-8/JSON.
- **Striktní DTO** zrcadlí serverové allowlisty: žádné cizí klíče (`privateEpoch`,
  `linearization`, `areaEpochs`, `revision`, identita aktéra), přesné typy, shoda s
  požadavkem (`areaFilter`, `view`, `timeZone`), pravidlo musí odpovídat okénku
  vydanému serverem, řazení (závažnost, `relevantOn`, bajty `taskId`), žádné
  duplicity, lifecycle shodný s `view`, `hasMore ⇒ plná stránka + kurzor`.
  Vydaný `attentionEpoch` je jediná povolená epocha.
- **Výsledky bez obsahu** `status`: `ok`, `unauthorized` (401/403), `stale` (409
  u čtení stránky), `conflict` (409 u příkazu/receiptu, včetně
  `resync_required`/`write_area_mismatch`), `not_found` (404), `invalid` (400 nebo
  lokální odmítnutí bez sítě), `unavailable` (jiný stav, síť u čtení, 429 u PATCH),
  `uncertain`, `aborted`, `invalid_response`.
- **PATCH nikdy neopakuje.** Po odeslání je `uncertain` vše nejednoznačné: pád
  sítě, abort, 5xx (včetně 503), neznámý stav i poškozená/cizí odpověď 200. Jen
  400/401/403/404/409/429 jsou definitivní. Abort *před* odesláním je `aborted`.
- Žádné logování a žádné automatické opakování nikde.

## Relace — `lib/target-staging-attention-session.ts`

`createAttentionSession({areaFilter,view,timeZone,limit,contextVersion,fetch?})`

- Explicitní `loadFirst()` / `loadMore()` / `reload()` (= `loadFirst`), nic se
  nenačítá samo ani předem. `getSnapshot()` vrací kopie; položky existují jen ve
  stavu `ready`. Stavy: `idle|loading|acting|ready|failed|suspended|invalidated|disposed`.
- `contextVersion` (BE-18): změna je terminální včetně A→B→A.
- `suspend()` / `resume()` (BE-19): smaže obsah a zruší běžící čtení; `resume()`
  nikdy sám nic nenačte.
- `dispose()` ruší rozpracovanou práci a zablokuje vše další.
- Stránkování ověřuje stejný serverový okamžik vyhodnocení, okénko a epochu,
  neopakuje kurzor, nepřipouští duplicity ani přeházené pořadí.

### Invalidace cache (jádro R2d.5e)

`act(item, action, snoozedUntilMs?)` provede preview → jedno PATCH → (jen při
`uncertain` jedno receipt) a **vždy** končí stavem `invalidated`
(`{status:"invalidated"}`), bez ohledu na výsledek (`committed`, `replayed`,
`conflict`, `not_found`, `invalid`, `unauthorized`, chyba preview, nejistota).

- Načtené stránky i kurzory se zahodí **při startu** `act` (stav `acting`), ne až
  po odpovědi: během neznámého výsledku nesmí být vidět zastaralý seznam a
  souběžné `loadMore`/`loadFirst`/`act` vrací `busy`.
- Seznam se **nikdy neupravuje optimisticky**. Jediným dalším krokem je explicitní
  `loadFirst()`/`reload()`, který data znovu autorizuje server.
- Příkaz se skládá výhradně ze serverového preview, vlastní kopie načtené položky
  (hledá se podle `attentionKey`, ostatní pole od volajícího se ignorují),
  `timeZone` relace a čerstvého `crypto.randomUUID()`. Volající nezadává ani
  aktéra, ani Oblast, ani revize.
- Lokální pojistka: pokud preview ukáže jinou `attentionEpoch`, jiný lifecycle
  nebo revizi řádku než načtená položka (jiná karta/zařízení už jednalo), PATCH se
  vůbec neodešle (`rejected: stale`). Nemožný přechod (např. restore aktivní
  položky) je `rejected: conflict`.
- `uncertain` → právě jedno receipt **stejného** příkazu → `committed |
  not_recorded | unknown`. `not_recorded` není důkaz o rollbacku; uživatel musí
  znovu načíst a rozhodnout znovu. Je-li relace po odeslání PATCH potlačena
  (`suspend`, `dispose`, změna kontextu), receipt se **neptá** (mohl by běžet pod
  jinou identitou) a výsledek je `uncertain/unknown`.
- Epocha: `loadMore` porovná `attentionEpoch` nové stránky s epochou načtených
  stránek; rozdíl zneplatní celý řetězec (`invalidated`). Po `act` se baseline
  nové epochy naučí až první stránka následného `loadFirst`.

## Proč žádný optimistický patch

Server je jediná autorita pro to, co aktér smí vidět a co je právě aktuální.
Lokálně upravený seznam by přežil odvolání přístupu, přeřazení úkolu nebo akci z
jiného zařízení a stal by se odvozeným kanálem, který nesmí přežít revokaci.
Proto je jedinou korektní reakcí zahodit vše a přečíst znovu.

## Povinnost UI

Kdykoli snapshot není `ready` (včetně `acting` a `invalidated`), UI musí zahodit
**vlastní kopie** položek (stavy komponent, paměťové mapy, DOM, titulky,
oznámení). Nesmí je ukládat do persistentního úložiště ani je znovu použít po
`resume()`, změně identity nebo `dispose()`. Výsledek `act` nese jen obsahově
neutrální kategorii; UI z něj nesmí odvozovat změnu seznamu.

## Testy

`tests/target-staging-attention-client.test.mjs` (hlavičky, credentials, no-store,
striktní matice DTO, mapování stavů, žádný retry, omezená těla, abort) a
`tests/target-staging-attention-session.test.mjs` (explicitní načítání, kopie,
busy, A→B→A, suspend/resume, dispose, `act` pro každý výsledek, receipt, epocha,
žádné persistenční API, žádná cizí data po invalidaci). Browser E2E až před
produkčním nasazením.
