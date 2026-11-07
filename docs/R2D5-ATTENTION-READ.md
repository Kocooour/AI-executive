# R2d.5a — autorizované Attention kandidáty aktéra (staging, interní)

První řez R2d.5. Čistě serverový, **staging-only, interní, jen čtecí**
selektor nad izolovaným cílovým úložištěm (schéma v22). Žádné HTTP,
UI ani push. Lifecycle stav (snooze/dismiss) čte selektor od R2d.5b.1
(viz [R2D5-ATTENTION-LIFECYCLE-SCHEMA.md](R2D5-ATTENTION-LIFECYCLE-SCHEMA.md));
zapisovač a doručení přijdou v dalších iteracích.

## Kontrakt

`readAuthorizedAttentionCandidatePage(db, request)` je nízkoúrovňový
selektor; důvěryhodný vstup musí pocházet z kanonicky preflightovaného
snapshotu. `readPreflightedAttentionCandidatePage` vynucuje tuto bránu
a `TargetStagingSessionAuthority.readAttentionCandidatePage` vytváří
podepsanou interní čtecí identitu (zavřená autorita nebo chyba → `null`).

Request: `actorUserId`, `areaFilter all|personal|shared`,
`view` (`active` | `hidden`, povinné), `evaluatedAtMs` (nezáporné bezpečné celé číslo), `timeZone` (IANA,
1–64 znaků, přísný regex a akceptace `Intl.DateTimeFormat`),
`limit` 1–100, `offset` 0–10 000, `restoreGeneration` (UUID).
Neplatný vstup vrací `null`; jakákoli chyba nebo anomálie **vydávaného**
řádku (typ, datum, Oblast mimo oprávněnou množinu, nesoulad pravidla a
severity) vrací celý výsledek `null` (fail-closed). Řádek úkolu, který SQL
nevybere žádným pravidlem, se nevydává ani nevaliduje — stejně jako u
selektoru Mého plánu; databázové CHECK omezení takové poškození běžně
nepřipustí. **Aktérův vlastní** lifecycle řádek se před výběrem ověří
celý: jakýkoli poškozený stav, termín odložení nebo revize vrací `null` v
obou pohledech (jinak by tiše odpovídal žádnému pohledu a kandidát by
zmizel). Poškozený stav jiného uživatele čtení aktéra neovlivní.

## Populace

Přesně populace Mého plánu: otevřené úkoly v aktérových soukromých
Oblastech a otevřené úkoly ve sdílených Oblastech, kde je aktér
**současný** editor/admin **a zároveň řešitel** úkolu. Projektové
úkoly dědí Oblast projektu. Viewer, nepřidělené, cizím lidem přidělené
a cizí soukromé úkoly nikdy nevytvoří kandidáta a neovlivní
`hasMore` ani revizi (kromě Area epoch). Dokončené úkoly nikdy.
`areaFilter` je průnik nad touto populací.

## Pravidla (rule version 1, v časovém pásmu `timeZone`)

`D = localDate(evaluatedAtMs)`. Termín celodenního `dueOn` nastává na
konci místního dne (`endOfLocalDate`, tj. začátek dalšího dne).

| ruleId | severity | podmínka |
|---|---|---|
| `deadline_overdue` | 1 | `dueOn < D` |
| `deadline_soon` | 2 | ne po termínu a `0 <= endOfLocalDate(dueOn) - evaluatedAt <= 48 h` |
| `planned_date_passed` | 5 | aktérovo vlastní `whenOn < D` a úkol nemá deadline položku |

`S` je největší datum z {D, D+1, D+2} splňující okno 48 h (počítá se
v JS přes `endOfLocalDate`, tedy správně při změně letního času);
`deadline_soon` je `D <= dueOn <= S`. „Nemá deadline položku“ znamená
`NOT (dueOn IS NOT NULL AND dueOn <= S)`. Úkol dává nejvýše jednu
položku (po termínu XOR brzy XOR plán). Cizí plány nikdy nerozhodují.

**Nevyhodnotitelná pravidla:** čekání (waiting), hygiena projektů
(bez dalšího kroku, nečinný projekt) a kalendářová pravidla nelze na
schématu v21 vyhodnotit (není stav čekání, stav projektu, časová razítka
aktivity ani kalendář), proto **nic nevytvářejí**.

## Lifecycle a `view` (R2d.5b.1)

Do téhož jediného SQL se po výpočtu `ruleId`/`relevantOn` připojí
`LEFT JOIN personal_attention_states` **výhradně na aktéra** a shodu
`(taskId, ruleId, relevantOn)`. Filtr se aplikuje **před** `ORDER BY`,
`LIMIT` a `OFFSET`, takže skryté položky nikdy neovlivní stránkování ani
`hasMore`:

- `view:"active"`: bez stavu, nebo `snoozed` s `snoozed_until_ms <= evaluatedAtMs`
  (vypršelý snooze se znovu vyhodnotí: položka se zobrazí jen proto, že podmínka
  stále platí; skončila-li, kandidát prostě neexistuje).
- `view:"hidden"`: `dismissed`, nebo `snoozed` s `snoozed_until_ms > evaluatedAtMs`.

Výstupní položka přidává `lifecycle: "active"|"snoozed"|"dismissed"`
(vypršelý snooze = `active`), `snoozedUntilMs` (jen u právě odloženého,
jinak `null`) a `lifecycleRevision` (revize stavového řádku, kdykoli řádek aktéra
existuje — i u vypršelého snooze, kde je `lifecycle: "active"`; jinak
`null`). Je to CAS vstup `expectedStateRevision` zapisovače R2d.5b.2. Nekonzistentní řádek stavu
(např. `dismissed` s časem, `snoozed` bez času) vrací celý výsledek `null`.

## Pořadí a stránkování

Jediný SQL příkaz (CTE): `ORDER BY severity ASC, relevantOn BINARY ASC,
taskId BINARY ASC LIMIT limit+1 OFFSET offset`. Uvnitř jedné severity
je pořadí `relevantOn` shodné s pořadím `relevantAt`; `taskId` je
deterministický tie-break, ze kterého je odvozen i klíč. **Odchylka od
PRODUCT:** schéma v21 nemá prioritu úkolu, proto krok „explicitní
priorita“ chybí, a místo `attentionKey` se jako poslední klíč používá
`taskId` (každý úkol má nejvýš jednu položku, pořadí je stejně stabilní
a SQL stránkování nemusí počítat hash). `D` a `S` jsou
vázané parametry. Záměrně **není** vracen celkový počet (nebyla
provedena revize úniku počtů), pouze `hasMore`.

## Výstupní položka (striktní allowlist)

`attentionKey, subjectType:"task", taskId, title, projectId, areaId,
areaKind, assignedToMe? (jen sdílené), ruleId, ruleVersion:1, severity,
reasonCode (= ruleId), relevantOn, relevantAt, dueOn, whenOn (jen
aktérovo), thresholdHours (0/48/0), sourceRevision` (revize úkolu).
Žádný lidský text důvodu — UI jej skládá z `ruleId` a dat. Nikdy
identifikátor jiného uživatele ani název nezpůsobilého úkolu.

`attentionKey = "tatt1:" + sha256hex("lumi:r2d5:attention:v1\0" +
JSON([ruleId, 1, taskId, "date-" + relevantOn]))`. Neobsahuje aktéra,
Oblast, workspace, název ani revizi: přesun mezi Oblastmi, úprava
názvu a navýšení revize klíč zachovají; změna termínu nebo plánovaného
dne je **nový výskyt** (dedup pravidla PRODUCT).

## Stránka a revize

`{items, hasMore, revision, evaluatedAtMs, timeZone, evaluationDate,
soonThroughDate, areaFilter, view, attentionEpoch, privateEpoch, linearization,
areaEpochs}`.
`revision` = sha256 přes doménu `lumi:r2d5:attention-candidates:v2\0`,
restore generation, aktéra, filtr, `view`, okamžik, pásmo, `D`, `S`, osobní
plánovací epoch, osobní attention epoch (`attentionEpoch`; chybějící
nebo poškozený řádek vrací celý výsledek `null`) a policy/content/project-content epochy **všech** oprávněných
Oblastí včetně prázdných. `attentionEpoch`, `privateEpoch`, `linearization` a
`areaEpochs` jsou **jen interní — nikdy se neposílají klientům**;
budoucí HTTP adaptér musí před vydáním ověřit LIVE session, Area
policy a osobní epochu. Revize zahrnuje okamžik vyhodnocení, takže se
mění s každým `evaluatedAtMs`; porovnání mezi dotazy musí okamžik
připnout (množina kandidátů je pro stejný okamžik deterministická).

## Poznámky

- Klíč obsahuje `ruleId`; rozhodnutí, že dismiss `deadline_soon` nepotlačí
  pozdější `deadline_overdue` téhož termínu, je v
  [R2D5-ATTENTION-LIFECYCLE-SCHEMA.md](R2D5-ATTENTION-LIFECYCLE-SCHEMA.md).
- Sdílená Oblast bez admina selže v preflightu (`shared_admin_missing`)
  a celé čtení je fail-closed pro všechny aktéry; jde o invariant úložiště.

## Testy

`tests/target-attention-read.test.mjs`: klasifikace pravidel,
řazení, stabilita klíče, ACL, revokace/degradace/přeřazení, filtr
Oblasti, pásma a DST, neplatný vstup, stránkování, autorita
(vč. živé revokace a close), allowlist bez úniků a lifecycle `view`
(skrytí/zobrazení, vypršelý snooze, stránkování bez skrytých, izolace
cizího stavu, revize, nový výskyt po změně termínu, soon → overdue).
