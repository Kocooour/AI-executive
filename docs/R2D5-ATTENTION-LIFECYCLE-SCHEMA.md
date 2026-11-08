# R2d.5b.1 — v22 soukromý lifecycle stav Attention

**Rozsah:** pouze nové, ručně vytvořené izolované staging SQLite
(schéma v22) a čtecí integrace do selektoru z R2d.5a. **Bez zapisovače,
HTTP, UI, push, migrace či produktové aktivace.** Příkazy
snooze/dismiss/restore (idempotentní, s receipty) přidal R2d.5b.2 ([zapisovač](R2D5-ATTENTION-LIFECYCLE-WRITER.md)).

## Model

Attention stav je **soukromý per-user** a nikdy neovlivní ostatní
uživatele ani sdílené task/Area revize a change log (kontrakt v
PRODUCT „Attention contract“ a ARCHITECTURE „Attention kandidát a jeho
lifecycle“).

- **Absence řádku = `active`.** Řádek existuje jen pro `snoozed` a
  `dismissed`.
- **`resolved` a `superseded` jsou odvozené**: kandidát přestal existovat
  (úkol dokončen, ztráta přístupu, nový termín/plán) a reconcile triggery
  stavový řádek **smažou**. Snooze, který vypršel po skončení podmínky,
  tedy nic znovu neaktivuje.
- Ruční dismiss **nedokončí** úkol (stav nemění `tasks`).

### `personal_attention_epochs`

Přesné zrcadlo `personal_plan_epochs`: řádek pro každou identitu vytváří
trigger `AFTER INSERT ON identities`; `user_id` je neměnné, `revision`
roste jen o +1, bez replace a bez delete. Je **oddělený** od plánovacího
epochu, takže snooze neneplatní stránkování Mého plánu.

### `personal_attention_states` (WITHOUT ROWID)

`user_id`, `task_id` (FK, `ON DELETE CASCADE`), `rule_id`
(`deadline_overdue | deadline_soon | planned_date_passed`),
`occurrence_on` (přísné Gregoriánské datum jako `when_on`),
`state` (`snoozed | dismissed`), `snoozed_until_ms`, `revision`.
PK `(user_id, task_id, rule_id, occurrence_on)`, index `(user_id, task_id)`.
CHECK: `snoozed` ⇒ celé číslo `0 < x <= 9007199254740991`;
`dismissed` ⇒ `NULL`.

## Triggery

1. **Insert guard** — otevřený úkol; soukromá Oblast patří `user_id`, nebo
   sdílená Oblast, kde je `user_id` řešitel a editor/admin (stejně jako
   plán). Navíc konzistence výskytu: deadline pravidla vyžadují
   `tasks.due_on = occurrence_on`, `planned_date_passed` vyžaduje
   **vlastní** plán `(user_id, task_id, when_on = occurrence_on)`.
2. **Update guard** — `user_id/task_id/rule_id/occurrence_on` neměnné,
   ACL i konzistence se znovu ověří.
3. **Revize** — `BEFORE UPDATE OF revision` jen +1; po změně
   `state`/`snoozed_until_ms` se revize stavu zvýší o 1 a zvýší se attention
   epoch uživatele.
4. **Bez replace, kapacita** `4096` (`TARGET_STAGING_MAX_ATTENTION_STATES`).
5. **Epoch** — `AFTER INSERT` a `AFTER DELETE` zvýší epoch řádku vlastníka
   (včetně ABA: delete + reinsert nevrací původní epoch).
6. **Reconcile** (mazání stavů, epoch zvýší trigger 5):
   - změna `assignee_user_id/status/project_id/area_id` úkolu: smazat stavy
     při nedokončeném `status<>'open'` nebo ztrátě přístupu;
   - změna `tasks.due_on`: smazat deadline stavy úkolu s jiným
     `occurrence_on` (nový termín = nový výskyt, supersession);
   - změna `personal_task_plans.when_on`: smazat `planned_date_passed`
     stavy uživatele pro úkol s jiným dnem; smazání plánu (i kaskádové
     z jiných reconcile triggerů a ze smazání úkolu): smazat planned stavy;
   - smazání člena, snížení role na viewer, přesun projektu mezi
     Oblastmi — zrcadlo plánovacích triggerů.
   Opětovné přiřazení stav **nikdy neobnoví**.
6. Nový řádek musí začínat `revision = 0` (insert guard). Samostatné
   navýšení `revision` bez změny stavu raw SQL nezablokuje, protože právě
   tak revizi navyšuje vnitřní AFTER trigger (stejný vzor jako
   `personal_task_plans`); veřejným zápisem bude až příkaz R2d.5b.2.

## Rozhodnutí: `ruleId` je součástí identity

Dismiss `deadline_soon` **nepotlačí** pozdější `deadline_overdue` téhož
termínu: je to jiný stavový klíč `(…, rule_id, occurrence_on)`, shodně s
legacy klíčem `lib/attention.ts` a s urgentní výjimkou PRODUCT pro nově
zpožděný termín. Naopak nový termín nebo nový plánovaný den je nový
výskyt a starý stav je smazán.

## Známé hranice (pro R2d.5b.2+)

- Skrytý `planned_date_passed` přežije doplnění termínu; po jeho
  odstranění se tentýž plánovaný den vrátí stále skrytý. Odpovídá pravidlu
  „dismiss potlačí tentýž výskyt“; zda je doplnění termínu podstatnou
  změnou, **rozhodl vlastník 2026-11-08: zůstává skrytý** ([rozhodnutí 2026-11-08](decisions/2026-11-08-ai-telo-poznamek-a-retence.md), Q2). Časové pásmo se bude brát ze serverového profilu v R2d.4k (Q1); do té doby ho dodává klient.
- Stav `deadline_soon` po přechodu na `deadline_overdue` smaže příkaz nad
  `deadline_overdue` téhož (úkol, výskyt) uživatele (R2d.5b.2,
  [zapisovač](R2D5-ATTENTION-LIFECYCLE-WRITER.md)). Řádek, který nikdo
  nepřepíše overdue příkazem, zůstane do změny termínu nebo dokončení úkolu
  a zabírá kapacitu (4096).

## Preflight

Nový kód `personal_attention_invalid`: kapacita; každá identita má
epoch a žádný epoch není osiřelý; každý stavový řádek je ACL-platný a
konzistentní s výskytem (deadline: `due_on = occurrence_on`; planned:
odpovídající plán) a splňuje sloupcové invarianty včetně rozsahu `revision`
řádku i epochy. Kontrola role je odolná vůči `NULL` (`COALESCE(m.role,'')`):
stav po zmizelém členství se neschová; stejná oprava platí pro dosavadní
kontrolu `personal_plan_invalid`. Jakákoli výjimka dotazu je tento nález.

## Čtení

Selektor (viz [R2D5-ATTENTION-READ.md](R2D5-ATTENTION-READ.md)) přijímá
povinné `view: "active" | "hidden"`, filtruje před řazením a stránkováním,
vrací `lifecycle`, `snoozedUntilMs`, `lifecycleRevision` a revize (doména
`v2`) zahrnuje `view` a `attentionEpoch`. Stav jiného uživatele se nikdy
nepřipojí.

## Žádné implicitní upgrady

`TARGET_STORE_SCHEMA_VERSION = 22`. Staging v21 a starší se nemigruje —
preflight jej odmítne. Žádný produkční reset ani cutover z tohoto PR
nevyplývá; legacy data, relace a cache se nemění.

## Testy

`tests/target-attention-lifecycle-schema.test.mjs` (epochy, guardy,
kapacita, revize/ABA, reconcile, preflight) a rozšířený
`tests/target-attention-read.test.mjs` (selektor).
