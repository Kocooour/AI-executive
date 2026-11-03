# R2d.3e — actor-scoped čtení stavu a termínu úkolu

Po schématu v20 (#210) zavádí tento PR **skutečný čtecí selektor** pro
`tasks.status`, `completed_at_ms` a `due_on` na izolovaném cílovém SQLite
stagingu. Nejde o produkční endpoint, UI ani implementaci Today/Upcoming.

## Rozsah

- `readAuthorizedTemporalTaskDetail`: konkrétní úkol; neexistující nebo
  nepřístupný se vrátí stejně jako `null`.
- `readAuthorizedTemporalTaskPage`: limit 1–100, offset max. 1 000 000;
  pouze `personal|shared|my-plan` a `all|open|completed`. Stabilní BINARY
  pořadí ID, `hasMore` a SHA-256 revize nad obnovovací generací a obsahovými
  epochami autorizovaných Oblastí. Jde o **interní** offset; HTTP smí přijmout
  jen serverem podepsaný cursor.
- DTO obsahuje jen ID, název, rodiče, efektivní Oblast, stav dokončení a
  deadline jako kalendářní datum. U sdílené Oblasti pouze `assignedToMe`;
  žádné jiné ID řešitele, osobní `today/when`, členství ani časové pásmo.
- Člen `viewer` smí číst sdílenou Oblast, ale `my-plan` zahrnuje ze sdíleného
  jen vlastní přiřazené úkoly v aktuální roli editor/admin. Samotné historické
  přiřazení po odebrání člena **nikdy neuděluje přístup**.
- Rozsah používá dvě omezená SQL čtení v jednom připnutém snapshotu
  (Area witness a stránka úkolů); rodičovské úkoly dědí Oblast projektu.
- `readPreflightedTemporalTaskPage/Detail` vyžadují read-only připnutý
  snapshot, kanonický preflight, ověřený actor ze signed read tokenu a
  kontrolu obnovovací generace. `TargetStagingSessionAuthority` zpřístupňuje
  tyto metody pouze důvěryhodným interním volajícím.
- Výsledky nesou `linearization` s aktuálními Area rolemi/policy. Před
  případným **budoucím HTTP** výstupem musí být witness znovu ověřen na
  živém store; tento PR žádnou route neaktivuje.

Revize stránky konzervativně zahrnuje epochy **všech** dostupných Oblastí
v rozsahu (včetně prázdných), tedy změna v jiné dostupné Oblasti může
zneplatnit i stránku bez jejího úkolu. Limit 1000 Oblastí odmítá výsledek
bez obsahu; výkonové zúžení witness může přijít později bez ústupku ACL.

## Testy a další krok

`tests/target-task-temporal-read.test.mjs` používá jen syntetická data:
více identit, soukromé/sdílené/Můj plán, viewer, projektové dědění,
open/completed filtry, přestupný den, no-leak DTO, page limit a revize
po ABA termínu, live revokaci a přístup přes připnutý authenticated facade.
Celé `pnpm test` i cílený R2d workflow se mají spustit na head PR.

Následuje samostatný default-off HTTP read s explicitním cursor/DTO
allowlistem a živým guardem; poté auditované idempotentní completion/due
write příkazy, per-user today/when a skutečné Today/Upcoming.

Bez změn produkčních dat, migrace, uživatelského UI, flagů a deploye.
Full Browser E2E výhradně jako gate před produkčním releasem.
