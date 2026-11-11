# R3-BE-4c.2 — Soukromý task CREATE přes reálné HTTP/SQLite

**Milník:** R3 — dokončit skutečný bezpečný Quick Capture úkolu v nejvýše 3 navazujících PR (core #390, tento HTTP+recovery PR, navazující FE). **Akceptace tohoto kroku:** owner nebo živá durable session vytvoří právě jeden samostatný úkol ve své existující privátní Oblasti prostřednictvím skutečného default-off `POST /api/target-staging/tasks`; skutečný child worker používá pinned staging SQLite, aktuální live actor + Area ACL, atomický journal, idempotentní retry a obsahově prázdný `POST /api/target-staging/tasks/create-status`. Bez produkčního zapnutí.

## Rozhraní a bezpečnost

- Jen pokud jsou všechny tři flagy explicitně `true`: `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED`. Výchozí stav vypnuto; GET task list zůstává nedotčený.
- Obě routy vyžadují reálné HTTP přihlášení, anti-rollback journal preflight, origin přesně shodný s URL, protokol `x-lumi-target-protocol: 1`, throttling, závaznou aktuální restore generation a živou relaci po návratu z child procesu. Žádný development-auth bypass.
- Request obsahuje **přesně** `{taskId,commandId,areaId,restoreGeneration,title}` se smluvenými ID a kanonickým task UUID; jiný actor, workspace, projekt, assignee a sdílení jsou odmítnuty. Worker předává data jen stdin, nikdy argumenty procesu, vrací pouze striktně validovaný content-free DTO. Vrstvená autorizace byla zachována v SQL `BEGIN IMMEDIATE` writeru z #390.
- Create vrátí `201 {ok:true,taskId}`; přesný idempotentní retry `200 {ok:true,taskId,replayed:true}`; konflikt stejného actor+command UUID s jiným payloadem `409`; nepřístupná Area `404`; stale generation `409 resync_required`. Čistý výsledek nemá titul ani informace o jiných uživatelích.
- Read-only create-status dostává **celý původní příkaz**, nikoli jen UUID: současný receipt obsahuje pouze digest a nemůže bezpečně rekonstruovat taskId z commandId. Proto musí klient při nejistotě zachovat nezměněný příkaz (včetně title) a volat `POST /api/target-staging/tasks/create-status`. Status `{status:"committed"}` je svázaný s přesným hashem a aktuálním soukromým task/Area oprávněním; `{status:"not_recorded"}` **neprokazuje, že dřívější in-flight HTTP POST nemůže teprve commitnout**. Nikdy automaticky nevytvářet nové taskId ani commandId kvůli timeoutu. Status nesmí vracet title, Area, actor ani receipt key.
- Externí audit, receipt a change log nejsou schváleným produkčním řešením retence. Stávající přísné capacity limity a pinned-fd staging režim se nemění.

## Akceptace a testy

Reprodukovat na izolovaném dočasném staging SQLite se syntetickou owner/durable identitou:

```bash
node --experimental-loader ./tests/ts-loader.mjs --test tests/target-staging-private-task-create-http.test.mjs tests/target-private-task-create-writer.test.mjs
```

Kritéria: jeden task, jedna nová change-log událost a receipt, bez názvu v anchor journalu; replay bez nové mutace; read-only status; cross-owner a sdílená Area 404; revoked session 401 bez write; neplatný origin/protocol/payload, legacy snapshot a vypnutá brána bez zápisu; primární legacy sentinel zachován. Navíc PR Checks: typecheck, build a relevantní regresní testy.

**Nezahrnuje:** FE Quick Capture úkolu, offline UI pending/uncertain/cancel/Undo, sdílené task create, reálné HumanWiki importy, produkční VFS, R4 cutover ani nasazení. Úplné browser E2E až na přesném releasovém SHA před produkcí. Následuje FE integrace v rámci stejného milníku.
