# R2d.3k.2 — interní autorizované čtení osobního `when`

**Rozsah:** pouze izolované staging SQLite v21. Bez HTTP,
UI, zápisu, migrace, produkční aktivace nebo změny společných úkolů.

## Kontrakt

`readAuthorizedPersonalWhenPage` vybírá výhradně **plány ověřeného
uživatele**, nikoli cizí soukromá data. Kanonicky preflightovaný snapshot
zprostředkují `readPreflightedPersonalWhenPage` a actor-bound
`TargetStagingSessionAuthority.readPersonalWhenPage`.

Výběr v SQL (před stránkováním) podporuje:
- `all`: všechny uživatelem naplánované otevřené úkoly;
- `on-day`: úkoly s `whenOn = evaluationDate`;
- `upcoming`: `evaluationDate < whenOn <= throughDate`, max. 90 dní.

Datum je striktně `YYYY-MM-DD` bez časových razítek. `limit`
je 1–100, `offset` 0–1 000 000, stabilní pořadí
`whenOn ASC, taskId COLLATE BINARY ASC`. Tyto offsety jsou pouze
interním serverovým kontraktem; žádný veřejný cursor se nezavedl.
Případné HTTP musí použít odděleně podepsaný actor/session-bound cursor.

**Minimální plánovací DTO:** `{taskId, whenOn, revision}`. Základní
sdílený úkol, jeho `title`, `dueOn`, členství, skutečný řešitel,
ostatní uživatelé ani cizí `when` se nevypisují. Následná kompozice
s úkoly musí mít vlastní autorizaci. Bez explicitního převzetí
sdíleného nepřiděleného úkolu zde žádný soukromý plán neexistuje.

## Oprávnění a konzistence

Čtení používá pouze `plan.user_id = verifiedActor` a zároveň
aktuální efektivní Oblast, status `open` a podmínku:
soukromý úkol vlastněný aktérem nebo sdílený úkol **přiřazený právě
tomuto editorovi/adminovi**. Viewer, nepřidělené a cizí úkoly jsou
vyloučené v SQL ještě před stránkováním. Projektové úkoly dědí Oblast.

Revize stránky zahrnuje restore generation, identitu uživatele,
výběrové okno, datumové hranice, jeho `personal_plan_epochs.revision`
a pozorované Area role/policy. **Jiný uživatel svým plánováním
tuto revizi nemění.** Výsledek obsahuje pouze serverový Area
`linearization` witness a `privateEpoch`; nejsou veřejným DTO.

`verifyTargetStagingReadLive` umí před případným vydáním odpovědi
v jediném aktuálním read snapshotu ověřit:
- dosud platnou session a přesnou totožnost aktéra;
- všechna pozorovaná oprávnění a policy revize Oblastí;
- **přesnou soukromou epochu** aktéra z v21.

Nesoulad vrací `stale` a nesmí se interpretovat jako platné oprávnění
nebo odhad aktuálního soukromého data. Budoucí HTTP adaptér musí volat
tuto variantu live guardu s autentizací a nesmí klientovi posílat
interní epochu ani podpisový materiál.

## Testy a pokračování

`tests/target-personal-when-read.test.mjs` ověřuje oddělení identity,
soukromý/sloučený projektový úkol, `all/on-day/upcoming`, stránkování,
chronologii, datové hranice, přesné soukromé DTO, kanonický preflight,
actor-bound facade, soukromé cursor revize, změny data a
revokaci členství/přiřazení před live release. Je součástí cíleného
workflow R2d.

**Další R2d.3k.3:** samostatně default-off HTTP čtení s podepsaným
soukromým cursorem a live guardem. Následně idempotentní plánovací
`set/clear` write s CAS, receipts a konzistencí. Plnohodnotné
Today/Upcoming teprve po kompozici soukromého `when`, společného
`dueOn` a kalendářových dat.
