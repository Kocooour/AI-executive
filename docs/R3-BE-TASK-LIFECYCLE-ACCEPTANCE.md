# R3-BE-QA-02 — integrace úkolů přes skutečné HTTP routy a SQLite

**Milník:** bezpečnostní akceptace R3 před R4. Nejde o nový runtime feature, produkční zapnutí nebo duplicitu [R3-BE-QA-01 — životní cyklus poznámek](R3-BE-NOTE-LIFECYCLE-ACCEPTANCE.md), který je v samostatném PR #385. Cílem je **skutečná návaznost** existujících backendových task endpointů, která dosud nebyla testována jako jeden průchozí tok.

## Kritéria přijetí

1. **Jedna skutečná privátní task relace:** serverově autorizovaný `GET /api/target-staging/tasks/:taskId` → `GET /title` poskytne revizi → `PATCH /title` ve stejném privátním prostoru vytvoří změnu s idempotentním command ID, přesná read-only `POST /title/status` potvrdí `committed`; stejné PATCH se bezpečně vrátí jako `replayed`, druhá operace s původní CAS musí vrátit konflikt. Zápis pak pokračuje do `POST /delete` a `POST /delete/status`, bez druhého delete commitu při retry.
2. **Transakční konzistence:** v jedné staging SQLite se ověří přesně jeden title audit, jeden delete audit, jeden tombstone a dvě příslušné change-log události. Po smazání privátní detail vrátí 404 a stránkovaný `GET /tasks?scope=personal` vynechá smazaný úkol. Canonical staging preflight musí stále projít.
3. **Druhá identita + oprávnění:** bob jako durable `editor` v sdílené Oblasti může bezpečně editovat task, carol jako `viewer` nesmí získat edit preview, zapisovat ani číst command receipt cizího aktéra; vlastní privátní data bob nejsou viditelná alice. Revokace bobovy durable session musí zablokovat detail, receipt, zápis i delete a nesmí způsobit vedlejší SQLite zápis. **Speciální race test:** pozastavit skutečný Node child writer mezi přijetím HTTP požadavku a vstupem do transakce, v mezidobí odvolat session přes kanonický durable writer, poté dítě pustit; pokus o DELETE musí vrátit `401 session_revoked` bez tombstonu, auditu a změny obsahu.
4. **Ochrana legacy a produkce:** test je pouze fiktivní dočasný SQLite v izolovaném `AI_EXECUTIVE_TARGET_STAGING_DIRECTORY`, legacy `AI_EXECUTIVE_DATA_DIR` obsahuje sentinel beze změn. Výchozí produkční feature gates se nemění, žádné automatické migrace, žádná změna HTTP odpovědí ani vystavení dat.

## Realizace

- `tests/r3-backend-task-lifecycle-http.test.mjs` — jeden běh skutečných Next route handlerů, včetně existujících child process writerů, canonical sqlite preflight, owner cookie, živé durable session, řízení rolí a content-free audit/tombstone/receiptu.
- Scénáře jsou izolované od ostatních CI procesů pomocí nového dočasného OS adresáře, vlastní staging DB a vlastních testovacích identit a session secret. Nevyužívají externí síť, skutečné soukromé poznámky ani produkční server.
- Spuštění:
```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/r3-backend-task-lifecycle-http.test.mjs
```

**Co to neprokazuje:** mobilní / desktopový prohlížeč, BFCache, reálný multi-user deployment, Quick Capture vytváření úkolů (staging nemá cílový create command/API), kompletní R3 release ani obnovu záloh. Cílené PR checks a review neobcházejí povinný plný Browser E2E na přesném release SHA před produkčním R4 přechodem. Všechna produkční feature flags zůstávají default-off.
