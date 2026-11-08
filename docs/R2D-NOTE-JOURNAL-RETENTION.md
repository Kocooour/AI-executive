# R2d.2c.2g.2b.5 – retence a komprese note žurnálu (schéma v24)

Pouze izolovaný staging, **operátorský** nástroj. Žádný HTTP endpoint, žádné UI, žádná produkční data
ani migrace (v24 je „fresh-only“, starší staging store se odmítne preflightem stejně jako dříve).
Vzorem je komprese změnového záznamu úkolů (R2c.2b, [ARCHITECTURE.md](ARCHITECTURE.md)).

## Schéma

- `note_journal_floors(area_id PK, floor_seq, revision)`: právě jeden řádek na Oblast, vytvořený
  triggerem při vložení Oblasti (`floor_seq = 0`, `revision = 0`). Podlaha se smí jen zvyšovat
  (striktně), `revision` roste přesně o 1, podlaha nikdy nepřekročí nejvyšší živé `seq` Oblasti.
  Řádek nelze smazat, nahradit ani vytvořit mimo trigger.
- `note_change_journal_guarded_delete` nahrazuje `note_change_journal_no_delete`: řádek lze smazat
  jen tehdy, když `seq <= floor_seq` jeho Oblasti (platí i pro přímé SQL). Update zůstává zakázán.
- Nové `seq` = `MAX(nejvyšší živé seq, floor_seq) + 1` pro Oblast, takže plně zkomprimovaná Oblast
  nikdy nepoužije číslo znovu; vložení řádku s `seq <= floor_seq` je odmítnuto.
- Kapacita `TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS` počítá jen živé řádky; komprese ji uvolní.
  **Pozor:** trvalé auditní tabulky poznámek (edit/delete/lifecycle) mají vlastní strop
  `TARGET_STAGING_AUDIT_MAX_EVENTS` (4096 na tabulku) a kompakce je nemaže; zápis se tedy
  zastaví na auditním stropu dřív než na stropu žurnálu. Retence auditu (export/archivace)
  je samostatné rozhodnutí pro R4, nikoli součást této kompakce.
- Auditní řádky Oblasti s podlahou > 0 zůstávají trvalé (spojení audit -> žurnál se po kompaci už
  nedá ověřit řádkem, proto se ověřuje počtem, viz níže).
- „Hlava“ Oblasti (stamp svědka, bootstrap, live guardy) je `MAX(živé seq, floor_seq)`.

## Preflight

Pro každou Oblast existuje právě jeden kanonický řádek podlahy; `revision` je v rozsahu
(`floor_seq > 0` ? 1 : 0) .. `floor_seq`; žádný živý řádek není na/pod podlahou a živá `seq` jsou
hustá nad podlahou (`seq - floor_seq` = počet řádků s `seq' <= seq`); a počet událostí odvozených
z auditů Oblasti (edit + delete + upsert + leave) je přesně `floor_seq + počet živých řádků`.
Chybějící žurnálový řádek k auditu je tedy přípustný jen v Oblasti s podlahou > 0 a jen v rozsahu,
který podlaha pokrývá. Porušení = `note_sync_journal_invalid`.

## Komprese

`compactTargetStagingNoteJournal(store, { now, retentionDays })`
(`lib/target-staging-note-journal-compaction.ts`, CLI `scripts/target-staging-compact-note-journal.mjs`
s `--directory`, `--generation`, `[--retention-days]`): pinned zápis s kanonickým preflightem uvnitř
transakce, omezený jediný retry jen při přechodném odmítnutí před tělem, odmítnutí s
`journal_present` při horkém `lumi-target.sqlite-journal` (přerušený zápis/obnova; postup viz
ARCHITECTURE R2c.2b). Pro každou Oblast: nová podlaha = `MIN(seq s committed_at_ms >= now − retence) − 1`,
jinak `MAX(seq)`, nikdy ne pod současnou; poté se smažou všechny řádky `seq <= podlaha` po dávkách.
Cursor přesně **na** podlaze se dál obsluhuje (všechny `seq > floor` existují); jen cursor
pod podlahou dostane `409 resync_required`.

Výsledek bez obsahu: `{ ok, areas, deleted }` (`areas` = Oblasti se zvýšenou podlahou).
Výchozí retence 30 dní, minimum 7 (návrh, rozhoduje vlastník). Do anchor žurnálu se zapíše
`compaction` intent s payloadem `{scope:"note_journal", areas, deleted}`.

## Proč nezůstává „poslední řádek poznámky“

U změnového záznamu úkolů zůstává poslední řádek každého klíče, protože feed a členství z něj
rekonstruují stav. Note sync takovou potřebu nemá: klient s cursorem **pod** podlahou musí stejně
znovu provést úplný bootstrap Oblasti ze živých poznámek (viz [R2D-NOTE-SYNC.md](R2D-NOTE-SYNC.md)),
a klient nad podlahou dostává všechny události `seq > cursor`, které všechny zůstávají. Proto se
mažou všechny řádky `seq <= podlaha`.

## Čtečka a HTTP

`readAuthorizedTargetNoteSyncPage` vrací pro cursor ve fázi `changes` s `afterSeq < floor_seq` `null`,
což stávající cesta mapuje na 409 `{"code":"resync_required"}`. Cursor přesně na podlaze se obslouží
(všechny události nad ní existují). Bootstrap po kompaci začíná na aktuální hlavě
(`MAX(živé seq, floor_seq)`). Chování nad podlahou se nemění.

## Testy

`tests/target-note-journal-retention.test.mjs`: pravidla triggerů, podlaha per Oblast, nezávislé
Oblasti, nepoužití `seq` znovu po úplné kompaci, uvolněná kapacita, cursor pod/na/nad podlahou přes
HTTP, preflight a zfalšované podlahy, CLI (argumenty, horký journal, špatná generace).
