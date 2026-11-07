# QA-01: synchronizovaný start testu dvou cold staging writerů

**Motivace:** úplná regrese `main` v běhu 42392104779 selhala ve starším testu 2 cold writerů / 20 000 journal záznamů. Jeden z procesů se vrátil jako `failed`, druhý `ok`. Z logu nelze určit, zda šlo o CPU/IO scheduling nebo skutečný problém v 200ms SQLite lock kontraktu.

## Změna pouze v testech
- Odstraněn pevný 100ms odstup mezi starty dvou nezávislých Node podprocesů. Nahrazen soukromým filesystem start gate: oba dokončí importy a oznámí `ready-<pid>`, až pak jsou **současně** uvolněni k vlastní cold validaci 20 000 záznamů a zápisu.
- Test nadále vyžaduje **oba úspěšné zápisy**, jeden journal řetězec bez pending intentu, dva navazující anchor kroky, a reálný původní **200ms busy_timeout**. Žádná změna transakční logiky, retry, časového limitu, validace či bezpečnostní hranice.
- Z výsledku testovacích podprocesů se uchovává také stderr pro diagnostiku případného skutečného selhání. V případě chyby startu se gate vždy uvolní, aby neběžely osiřelé děti.

## Ověření
Primární brána: `PR Checks` s testem `target-staging-anchor-journal.test.mjs` a všemi souvisejícími unit/security testy. Po sloučení vyžadovat úspěšnou **Main Regression**. Pokud 200ms race stále selhává, pokračovat diagnostikou skutečného lock holdera a příčiny `failed`; nevypínat žádný test.

Jde o syntetická stagingová data; žádný produkční zápis, deploy, data reset, změna oprávnění ani oslabení bezpečnostní politiky.
