# R2d.3j.1 — autorizované serverové výběry podle společného deadline

**Rozsah:** interní čtení pouze z izolovaného staging SQLite v20.
Bez HTTP endpointu, UI, migrace, produkční aktivace nebo zápisu.

## Co tato iterace skutečně dodává

Nová metoda `readAuthorizedTemporalDueWindowPage`, připnuté čtení
`readPreflightedTemporalDueWindowPage` a serverový facade
`TargetStagingSessionAuthority.readTemporalDueWindowPage` bezpečně vybírají
**otevřené úkoly s vyplněným společným termínem `dueOn`**:

- `overdue`: `dueOn < evaluationDate`
- `due-today`: `dueOn = evaluationDate`
- `upcoming`: `evaluationDate < dueOn <= throughDate`, horizont 1–90 dní

`evaluationDate` je explicitní kalendářní datum `YYYY-MM-DD`, které
musí důvěryhodný volající získat pro časové pásmo **konkrétního uživatele**.
Serverový selektor neodvozuje datum z vlastních UTC hodin, nepřijímá
časová pásma ani nepřevádí časové značky. Roky 0001–9999 a gregoriánský
kalendář jsou validované aritmeticky bez `Date.parse` a přetečení.

Výběr respektuje existující bezpečnostní hranice `personal`,
`shared`, `my-plan`: sdílený viewer může číst příslušné sdílené úkoly,
ale `my-plan` vyžaduje současného editora/admina a úkol přidělený jemu.
Úkoly v projektech dědí Oblast. Zaniklé členství, cizí soukromé úkoly,
úkoly bez termínu a dokončené úkoly se nesmějí objevit.

Datový filtr probíhá **v SQL před stránkováním**, řazení je deterministické
(`dueOn`, binární ID, SQLite rowid); stránka má limit 1–100, offset max.
1 000 000, `hasMore` a SHA-256 revizi navázanou na restore generation,
rozsah, okno, oba kalendářní parametry a revize všech autorizovaných
Oblastí včetně prázdných. Oprávnění, identita a kanonický preflight jsou
ověřené v **jediném připnutém snapshotu**; výsledek nese Area
`linearization` witness. Případný budoucí HTTP route musí witness ještě
synchronně ověřit proti aktuálnímu živému store **před odesláním výsledku**.
Žádný HTTP cursor ani veřejný offset v tomto PR nevzniká.

## Důležitá hranice úplnosti

Jde o **deadline výběry, nikoli kompletní Today/Upcoming nebo plán dne**.
Pole `when` (osobní plánovaný den sdíleného úkolu), snooze, kalendářní
bloky a osobní priority do této iterace nepatří. Taková data nesmějí být
odvozena ze společného `dueOn` a jejich budoucí uložení musí izolovat
jednotlivé uživatele a výslovné převzetí nepřiděleného úkolu.

## Testy

`tests/target-task-due-window-read.test.mjs`: přestupné roky včetně
centurií, validace data/horizontu, SQL filtrování před pagination, stabilní
řazení, pohyby a ABA revizí, privátní/sdílené/Můj plán včetně viewer,
nepřidělených a projektových úkolů, odvolání členství, přímý API selector,
připnutý read facade, kanonický preflight i nezměněná legacy data.
Test je zahrnutý v zaměřeném R2d workflow.

**Následuje:** samostatný default-off HTTP read s podepsaným cursorem,
striktním DTO a live release ACL guardem; následně per-user `when` a
celkové Today/Upcoming komponování bez míchání společného a soukromého.
