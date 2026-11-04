# R2d.3m.3 — interní globální index projektů

**Pouze izolovaný staging SQLite v21.** Po sloučených R2d.3m.1
a R2d.3m.2 (task-only globální Vše) vzniká samostatný interní
`readAuthorizedGlobalProjectPage` pro projekty v globálním rozsahu
**Vše / Osobní / Sdílené**. Rozšiřuje autorizované typy položek,
ale **není** úplným globálním read-adaptérem všech položek Lumi.
Nic se neaktivuje v produkci ani v UI.

## Semantika

- `all`: všechny projekty v soukromých Oblastech aktéra a
  všechny projekty v dostupných sdílených Oblastech
  (`viewer/editor/admin`), včetně prázdných projektů a projektů
  bez jediného úkolu přiřazeného aktérovi.
- `personal`: jen projekty v aktérových soukromých Oblastech.
- `shared`: všechny projekty v aktuálně čitelných sdílených
  Oblastech, i pro `viewer`.

**Můj plán není Vše:** jeho existující projektový selektor
nadále omezuje sdílené projekty na práci přiřazenou uživateli.
Globální projektový index nezveřejňuje soukromé projekty jiných
lidí ani interní identifikátory členů nebo řešitelů.

## Atomické čtení a živá autorizační bariéra

Interní `readPreflightedGlobalProjectPage` a
`TargetStagingSessionAuthority.readGlobalProjectPage` vyžadují
kanonický preflight, podpisem ověřeného aktéra a jeden
připnutý SQLite read snapshot. SQL aplikuje aktuální Area ACL
a filtr rozsahu **před** `LIMIT/OFFSET` (limit 1–100,
offset do 1 000 000). Identifikátory projektů musí projít
stejnými SQL předfiltry jako existující autorizovaný
projektový index, aby neplatné ID nezabíralo pozici ve
stránkování. Stabilní pořadí je `projectId COLLATE BINARY`.

Projektový řádek:
`{id,title,areaId,areaKind}`.
Vnitřní odpověď obsahuje navíc serverové `scope`,
`hasMore`, `revision`, `linearization` a
`areaEpochs`. Revize stránky je doménově oddělený SHA-256
hash obsahující aktéra, rozsah, restore generation a
úplnou, seřazenou množinu dostupných Oblastí **včetně
prázdných**, s jejich rolemi a policy/content/project-content
epochami. Změna sdíleného projektu, jeho Oblasti nebo
členství zneplatní následné stránkování.

Pro budoucí HTTP rozhraní je povinné atomické
`verifyTargetStagingReadLive` s celým aktuálním Area
witness: `scope=global-all` pro Vše a existující
`personal/shared` pro jednotlivé rozsahy.
Kontrola živé session/aktéra, členství a obsahových epoch
musí proběhnout **před vydáním** projektových názvů.
Vnitřní linearization/epoch svědci se nesmí propustit do
klientské odpovědi.

## Testy a pokračování

`tests/target-global-project-read.test.mjs` ověřuje
vlastní i cizí projekty, `viewer/editor/admin`,
prázdné sdílené projekty, rozdíl proti Mému plánu,
BINARY stránkování, neplatné argumenty, změny
projektových revizí, změnu přístupu, nově získanou
prázdnou Oblast, atomické live guardy a revokaci
durable session. Zahrnuto do cíleného R2d CI.

**R2d.3m.4**: samostatně výchozí vypnuté HTTP čtení
projektového globálního indexu s izolovaným child,
přísným DTO a podepsaným kurzorem. Poté pokračuje
bezpečná agregace poznámek a teprve pak společný
read-adaptér v UI-09/R3. Žádné migrace,
cutover ani zapnutí serverových feature flags
bez výslovného schválení produkčního kroku.
