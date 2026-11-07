# R2d.5b.2 — interní zápis lifecycle stavu Attention

**Izolovaný v22 staging, pouze serverová knihovna.** Žádné HTTP, UI, push,
výchozí aktivování, migrace ani produkční nasazení. Zrcadlí zapisovač
osobního plánu ([R2D-TASK-PERSONAL-WHEN-WRITER.md](R2D-TASK-PERSONAL-WHEN-WRITER.md)).

## Příkaz

`TargetStagingSessionAuthority.changeAttentionLifecycle(writeSession, command,
durableSessionTokenHash?)` provádí jeden atomický `snooze | dismiss | restore`
pouze pro **aktuálně ověřeného aktéra**; aktér se v těle nezadává.
Přesně jedenáct údajů:

- `commandId` (UUID v1–v8), `taskId`,
- `ruleId` (`deadline_overdue | deadline_soon | planned_date_passed`),
- `occurrenceOn` (striktní gregoriánské datum výskytu, nikdy `null`),
- `action`, `snoozedUntilMs` (kladné bezpečné celé číslo pro `snooze`,
  jinak `null`),
- `expectedRevision` (task/Area/restore CAS), `expectedAttentionEpoch`
  (epocha `personal_attention_epochs` aktéra), `expectedStateRevision`
  (revize řádku nebo `null`, pokud řádek neexistuje),
- `writeAreaId`, `restoreGeneration`,
- `timeZone` (IANA pásmo aktéra; stejná validace jako u selektoru).

Výsledek je `{ok:true}`, `{ok:true,replayed:true}` nebo obsahem nesdělující
kód (`invalid_request`, `not_active`, `unauthorized`, `unavailable`, `stale_revision`,
`idempotency_conflict`, `unchanged`, `write_failed`, `session_revoked`,
`resync_required`, `write_area_mismatch`).

## Pořadí kontrol (jedna `BEGIN IMMEDIATE` transakce)

1. Ověřený aktér se zápisovou credential; živost durable session.
2. Task/Area write kontrakt; úkol je otevřený a je buď soukromý aktéra,
   nebo sdílený a **přiřazený aktérovi** (jinak `unavailable`).
3. Výskyt je stále aktuální: deadline pravidla vyžadují
   `tasks.due_on = occurrenceOn`, `planned_date_passed` vlastní plán
   `when_on = occurrenceOn`; jinak `unavailable` (nic se nevrací).
4. Receipt (až po autorizaci): shodný digest = replay, jiný =
   `idempotency_conflict`.
5. CAS: revize úkolu, attention epocha, revize stavového řádku; jinak
   `stale_revision`.
6. Aktuální kandidát: pro `snooze`/`dismiss` musí podle serverového času
   a `timeZone` právě platit **stejné** pravidlo jako v selektoru
   (`currentAttentionRule` nad `attentionEvaluationWindow`); jinak
   `unavailable`. Nelze tedy předem skrýt budoucí termín, „soon“ mimo 48 h
   ani „soon“ výskytu, který je už po termínu. `restore` (Undo) okno
   nepotřebuje.
7. Mez snoozu: `now < snoozedUntilMs <= now + 30 dní` (jediné `now`
   uvnitř transakce), jinak `invalid_request`.
8. Přechody: `snooze` a `dismiss` jen z efektivně aktivního stavu (bez
   řádku, nebo `snoozed` řádek s `snoozed_until_ms <= now`, který se
   `UPDATE`uje); z platného snoozu či dismissu `not_active` a nic se nezapíše.
   `restore` (Undo) je možný z `snoozed` (i vypršelého) a `dismissed`;
   bez řádku `unchanged`.
9. Pinned/sidecar kontroly a kapacita receiptů.
10. Zápis pouze vlastního řádku: restore = `DELETE`, snooze/dismiss =
   `INSERT` (revize 0) nebo `UPDATE`. Ověří se, že epocha vzrostla přesně o
   počet změn řádků a revize řádku odpovídá; jinak `write_failed`.
11. Receipt, znovu session/pinned, journal intent.

## Politika

Sémantika následuje R2d.5b.0 / PR #317 (strop snoozu 30 dní, přechody
pouze z aktivního stavu, dismiss nikdy nedokončí úkol, klíče vázané na
pravidlo) s vědomým doplněním `restore` pro Undo. Vypršení snoozu je
implicitní při čtení (`until <= now`), nikoli explicitní recheck záznam,
protože schéma v22 neukládá sloupce `changedAt` ani zdrojovou revizi.
Selektor proto vrací `lifecycleRevision` i u vypršelého snoozu (řádek
stále existuje), aby klient sestavil platné `expectedStateRevision` bez
dalšího čtení. `replayed:true` potvrzuje jen dřívější provedení příkazu,
nikoli aktuální stav (po Undo může být položka znovu aktivní).
`attentionEpoch` stránky je pro budoucí HTTP vrstvu (R2d.5c) CAS vstupem
příkazu; jeho zveřejnění klientovi navrhne až tato vrstva.

## Úklid `deadline_soon`

Příkaz nad `deadline_overdue` pro (úkol, výskyt) smaže i **vlastní** řádek
`deadline_soon` téhož výskytu (epocha +2): po přechodu na zpoždění se
„brzy“ téhož termínu už nemůže vrátit. Řádky jiných úkolů a uživatelů se
nedotknou.

## Receipt a journal

Prefix `r2:task-personal-attention-receipt-v1:` (doména
`personal-attention-v1`) má vlastní kapacitu `TARGET_STAGING_MAX_RECEIPTS`
a je validován v preflightu jako prefix osobního plánu. Journal intent
`personal_attention` nese pouze `{receiptHash, epoch, action}`
(`snooze=0`, `dismiss=1`, `restore=2`) — žádného aktéra, úkol, pravidlo ani
datum.

## Neměnnost sdíleného stavu

Příkazy nemění `tasks`, sdílené revize, `change_log` ani epochy plánu.
Pouze připojí/odebere řádky `personal_attention_states` aktéra.

## Testy

`tests/target-attention-lifecycle-writer.test.mjs`.
