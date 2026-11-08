# R2d.4i/4j — autorizovaný Context Resolver bundle pro AI (staging, interní)

Minimální kontext pro **budoucí** volání poskytovatele AI. Slice je čistě
serverový, **staging-only, interní a jen čtecí**: žádné volání modelu či sítě,
žádná HTTP trasa, UI ani změna schématu. Chat/AI není druhé úložiště dat ani
obejití autorizace ([PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md)):
bundle je složen **výhradně** z již autorizovaných, na aktéra vázaných selektorů
a autorizace proběhne před serializací.

## API

- `resolveAuthorizedTargetContextBundle(db, request)` — úroveň DB, musí běžet v
  jednom připnutém read snapshotu; `actorUserId` musí pocházet z ověřeného
  přihlašovacího údaje. Neexistující identita → `null`.
- `readPreflightedTargetContextBundle(store, credential, request)` — kanonický
  preflight + podepsaný aktér + **jeden** snapshot (`readPreflightedStoreSnapshot`).
- `TargetStagingSessionAuthority.resolveContextBundle(actorUserId, request)` —
  zavřená autorita, neplatný nebo neexistující aktér → `null`.
- `serializeTargetContextBundleForProvider(bundle)` — JSON jen veřejné části
  (bez `witness`, ID Oblastí a cizích ID uživatelů; těla jen autorizovaných
  poznámek ve `find`); `null`, pokud by přesáhl strop.

## Požadavek (přesně 6 klíčů, jinak `null`)

`purpose`, `scope`, `query`, `nowMs` (nezáporné bezpečné celé číslo — serverové
hodiny dodává volající autority), `timeZone` (validuje
`attentionEvaluationWindow`), `maxItems` 1–50.

| purpose | povolené scope | query |
|---|---|---|
| `what_matters` | `my-plan` \| `personal` \| `shared` | `null` |
| `plan_today` | `my-plan` \| `personal` \| `shared` | `null` |
| `find` | `all` \| `personal` \| `shared` | povinný, validace jako u titulkového hledání |

`all` je pro `what_matters` / `plan_today` **zamítnuto** (populace Attention a
Mého plánu není globální Vše; `personal`/`shared` ji jen zužují), `my-plan` je
zamítnuto pro `find`. Odchylka od zadání: dotaz používá existující
`validAuthorizedTitleQuery` (2–80 znaků, bez řídicích znaků, max 8 termínů),
nikoli 1–120 — jedna validace pro jedno hledání.

## Složení (vše z téhož snapshotu)

- `what_matters`: aktivní Attention kandidáti (stránka max 100) a úkoly Mého
  plánu na dnes; nejprve Attention (závažnost, datum, ID), pak zbylé úkoly dne.
- `plan_today`: Můj plán dnes + následující den (dvě disjunktní okna) s
  informací Attention připojenou k úkolu.
- `find`: autorizované titulkové hledání (`title_search`), `maxItems`; každá
  položka `kind:"note"` navíc nese `body` (viz níže).

Odložené/zamítnuté Attention se nezahrnuje (úkol zůstane v plánu bez
`attention`). Stejná entita se **sloučí**; zdroj je `attention`, má-li úkol
aktivní Attention (revize = revize úkolu), jinak `my_plan` (revize `null`,
zdroj ji nevydává); u `title_search` je revize `null`. Rozpor sloučených zdrojů,
jiný `linearization` / `areaEpochs` / `privateEpoch`, nebo `null` kteréhokoli
zdroje → celý výsledek `null` (fail-closed).

## Výstup (striktní allowlist)

`bundleVersion:1, purpose, scope, generatedAtMs, timeZone, evaluationDate,
items[], truncated, revision`. Položka: `kind, id, title, areaKind,
assignedToMe?, dueOn?, whenOn?, attention?{ruleId,severity,relevantOn,lifecycle},
body?, bodyTruncated?, provenance{source,revision}`. `whenOn` je jen osobní den aktéra. Nikdy ID
Oblasti, projektu, přiřazené osoby ani jiných uživatelů.

- **Těla poznámek (R2d.4j, rozhodnutí vlastníka 2026-11-08,
  [záznam](decisions/2026-11-08-ai-telo-poznamek-a-retence.md)):** jen u položek
  `kind:"note"` ve `find`, **výhradně** z `readAuthorizedTargetNote(db,{actorUserId,noteId})`
  uvnitř téhož připnutého snapshotu jako hledání. Vrátí-li čtení `null`, nebo se
  liší `areaKind`, název či rodičovský projekt oproti řádku hledání, je celý
  balík `null` (fail-closed). Tělo je omezeno na `MAX_CONTEXT_NOTE_BODY_BYTES`
  = 4096 bajtů UTF-8, řez na hranici kódového bodu; při zkrácení je
  `bodyTruncated:true` (jinak klíč chybí). Provenance revize u poznámky je
  revize z autorizovaného čtení. Úkoly a projekty tělo nemají; `what_matters` /
  `plan_today` zůstávají jen úkolové. Viewer sdílené Oblasti dostane těla jen
  poznámek, které smí číst; cizí těla se nikdy nevydají.
- `truncated` odráží pouze výsledky autorizované pro aktéra (limit položek,
  `hasMore` zdrojů, strop bajtů); nikdy počty neautorizovaných položek. Je
  konzervativní: `true` může znamenat „možná víc“.
- Strop veřejného JSON je 32 KiB; odstraňují se položky s nejnižší prioritou
  (od konce) a nastaví se `truncated`.
- `revision` = SHA-256 s doménou `lumi:r2d4:context-bundle:v1\0` přes vstupy,
  revize všech zdrojových stránek a finální položky včetně vydaných těl (úprava těla mění revizi; cizí aktivita revizi aktéra nemění).

## Interní `witness`

`{linearization, areaEpochs, noteAreaEpochs, privateEpoch, attentionEpoch,
sourceRevisions, noteGuards[{noteId,noteRevision,parentRevision}]}` je jen pro budoucí **živou release bariéru** (ověření
session, členství v Oblastech, epoch). Nikdy se neposílá poskytovateli ani
klientovi; veřejná serializace jej neobsahuje.

## Testy

`tests/target-context-bundle.test.mjs`: oracle proti selektorům, deduplikace a
pořadí, matice soukromí (bob editor, carol viewer, erin cizí), odvolání /
přeřazení / dokončení / dismiss / snooze mění bundle i revizi, validace, strop
bajtů a determinismus, autorita (zavřená, neznámý aktér).

## Hranice zjištěné nezávislým testem

- **Fail-closed na poškozená data aktéra:** poškozený vlastní `when_on` (obejití
  CHECK) nebo prázdný titulek vydávané položky vrací celý balík `null`, nikdy
  částečný výsledek. Dokončený úkol s chybějícím `completed_at_ms` se do balíku
  nedostane (vybírají se jen otevřené úkoly); takové poškození odhalí preflight.
- **Pozornost nad 100 řádků:** zdroje se čtou s limitem 100; v `plan_today` může
  úkol z Mého plánu přijít bez připojené pozornosti, pokud je jeho pozornost až
  za první stránkou. Signalizuje to `truncated:true`; asistent má v tom případě
  považovat seznam za neúplný.
- **`find`** řadí podle ID (pořadí titulkového hledání), nikoli podle relevance, a
  obsahuje i dokončené úkoly (titulkové hledání nefiltruje stav) — **vlastník
  2026-11-08 potvrdil, že je to žádoucí** (zaznamenáno v rozhodnutí výše).
- `id` položky je ID vlastní entity (úkolu, projektu, poznámky) — nikdy ID
  Oblasti, rodičovského projektu, řešitele ani jiného uživatele.
- `revision` zahrnuje `nowMs`; dva balíky ze stejných dat v různý okamžik mají
  jinou revizi (nevhodné jako klíč cache).
- Nízkoúrovňový `resolveAuthorizedTargetContextBundle` věří předané
  `restoreGeneration`; vynucená cesta je `readPreflightedTargetContextBundle` /
  autorita (preflight + ověřený aktér).

- Znak NUL (U+0000) v těle poznámky odmítají všechny zápisové cesty (úprava i vytvoření
  poznámky). Řádek vložený přímo SQL by `node:sqlite` při čtení ořízl na prvním NUL — to platí
  stejně pro detail poznámky i pro AI balík; jde o hranici přímé manipulace s DB, ne o běžnou cestu.
- Ořez na 4096 bajtů respektuje hranice kódových bodů, nikoli grafémů: kombinující znak na samém
  konci limitu může odpadnout (např. přízvuk od základního písmene).
