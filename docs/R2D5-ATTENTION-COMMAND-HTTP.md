# R2d.5c.2 — výchozí vypnuté HTTP příkazy životního cyklu Attention

**Pouze izolovaný staging SQLite v22.** Zpřístupňuje writer
`changeAttentionLifecycle` ([R2D5-ATTENTION-LIFECYCLE-WRITER.md](R2D5-ATTENTION-LIFECYCLE-WRITER.md))
třemi endpointy pro právě přihlášeného aktéra. Bez UI, push, produkčního
nasazení, migrace nebo resetu. Čtení kandidátů zůstává v
[R2D5-ATTENTION-HTTP.md](R2D5-ATTENTION-HTTP.md).

## Vypínací bariéry

Všechny tři metody vyžadují současně `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`,
`..._HTTP_WRITE_ENABLED`, `..._HTTP_ATTENTION_ENABLED` a nový
`..._HTTP_ATTENTION_WRITE_ENABLED`, každý přesně `"true"`; jinak 404. Stejně jako
u personal-when příkazu platí totéž pro izolovaná child procesy (nové flagy jsou
v allowlistu prostředí dětí) a flagy se po práci dítěte znovu ověřují (jinak 503).

## `GET /api/target-staging/attention/command?taskId=&ruleId=&occurrenceOn=`

Přesně tyto tři klíče, každý jednou (`ruleId` ∈ `deadline_overdue|deadline_soon|planned_date_passed`,
`occurrenceOn` striktní datum), jinak 400. Odpověď je z **jednoho** připnutého,
preflightovaného snapshotu a obsahuje právě CAS vstupy příkazu:

`expectedRevision, expectedAttentionEpoch, expectedStateRevision, writeAreaId,
restoreGeneration, lifecycle ("active"|"snoozed"|"dismissed"), snoozedUntilMs`.

`lifecycle` se odvodí ze surového řádku a hodin serveru: bez řádku `active`
(`expectedStateRevision:null`); expirovaný snooze je `active` se zachovanou revizí
řádku (writer ho nejprve smaže jako `snooze_expired`); `snoozedUntilMs` je jen u
aktuálně odložené položky. Preview se vydá jen pro otevřený úkol, který aktér vlastní
(soukromý) nebo má přiřazený (sdílený, editor/admin), a jen pro výskyt, který je stále
datem úkolu (`dueOn`, u `planned_date_passed` vlastní plán aktéra). Jinak nerozlišitelné
**404** (viewer, nepřiřazený, cizí, dokončený, neexistující, neplatný výskyt). Neobsahuje
titul, data, aktéra ani vnitřní svědky. Před odpovědí proběhne živá release bariéra:
session, Area/policy, revize úkolu a `personalAttentionGuard` (epocha attention); stale je 404.

## `PATCH /api/target-staging/attention/command`

Tělo je přesně příkaz writeru (12 klíčů včetně `timeZone`). Stejné kontroly jako
personal-when: Origin shodný s URL, hlavička protokolu, žádný query string, limit 32 KiB,
rate limit 30 / 600 s, identita, konfigurace. Hash durable relace předá rodič dítěti
a ověří se znovu uvnitř `BEGIN IMMEDIATE`. Odpověď je jen `{ok:true}`,
`{ok:true,replayed:true}` nebo `{error}`:

| výsledek writeru | HTTP |
| --- | --- |
| `unavailable` | 404 |
| `invalid_request` (např. snooze mimo okno, 30 dní) | 400 |
| `resync_required` / `write_area_mismatch` | stejné odpovědi jako u ostatních příkazů |
| `stale_revision`, `idempotency_conflict`, `unchanged`, `not_active` | 409 `Revision conflict` |
| `session_revoked` | 401 |
| `write_failed`, nedostupné dítě | 503 |

## `POST /api/target-staging/attention/command/receipt`

Totéž 12klíčové tělo; **jen čtení**. V jednom snapshotu se nejprve ověří aktuální
write ACL (úkol, Area, přiřazení, výskyt), teprve poté se hledá receipt. Odpověď
`{status:"committed"|"not_recorded"}`; jiný payload se stejným `commandId` je 409,
nedostupný úkol 404. Starý CAS příkazu se vůči živým revizím nepřekontrolovává
(jen se porovná s digestem receiptu). Před odpovědí se ověří i attention epocha téhož
snapshotu. Receipt nikdy nic nemění a nevrací titul, aktéra ani data.

## Odchylky a rozhodnutí

- Child `write` navíc propouští důvody `invalid_request` a `not_active` (writer je
  vrací legitimně); `unauthorized` zůstává 503 jako u šablony.
- Receipt používá jen atomický snapshot (preview + receipt), neexistuje samostatné
  nesnapshotové receipt dítě.
- Testy: `tests/target-staging-attention-command-http.test.mjs`.
