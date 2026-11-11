# R3-FE-6 — Quick Capture soukromého samostatného úkolu

**Milník:** [R3 private task create](R3-BE-04C-PRIVATE-TASK-CREATE-HTTP.md),
třetí ze 3 plánovaných integračních PR (#390 core → #393 HTTP + exact receipt → tento FE).
**Akceptační krok / syntetický:** skutečný default-off klientský formulář hlavního
Lumi UI odešle právě jeden reálně autorizovaný private task CREATE na existující
HTTP API. Testy používají pouze syntetická data, bez zapnutí produkce nebo R4.

## Uživatelský tok

1. V opt-in UI při současně povoleném cílovém Notes/Area transportu a vlastních
   task-write branách globální plovoucí **+** (telefon, desktop, klávesová
   zkratka i detail) nabídne **Úkol / Poznámka**. V Notes obrazovce zůstává
   přímá akce Nová soukromá poznámka beze změny. Žádná záložka Hledání ve
   spodním menu se nezavádí. Při vypnuté task UI bráně zůstává starý notes-only
   tok přesně zachován.
2. Formulář úkolu čerstvě načítá serverově autorizované soukromé zapisovatelné
   Oblasti z `GET /api/target-staging/notes/create-targets` (transportní
   sdílení s poznámkami). Uživatel **vždy výslovně** vybere Oblast. Před
   odesláním proběhne `POST /api/target-staging/notes/create-preview` pro
   read-only `restoreGeneration`. Toto samo není oprávnění k zápisu;
   task create HTTP znovu ověřuje živou identitu, Area, generation a
   transakční ACL.
3. Jediný nový `taskId` a `commandId` se vytvoří před jedním
   `POST /api/target-staging/tasks`. Podporuje jen samostatný soukromý
   úkol, bez projektu, přiřazených osob, sdílení, termínu a priority.
   Výsledek se **nepřidává optimisticky** do Mého plánu (úkol nemá Kdy).
   Viditelná zpráva v hlavní obrazovce se objeví až po přesném serverovém
   potvrzení.
4. Timeout, revokace během requestu, nevysvětlené 4xx/5xx, neplatná 2xx
   odpověď a výpadek sítě jsou **uncertain** — žádný nový příkaz,
   automatic retry, local insert, legacy fallback ani klientské Undo.
   Stavový marker v `sessionStorage` obsahuje **pouze**
   `{generation,commandId}`. Celý příkaz včetně názvu zůstává pouze
   v paměti stejné aktuální autentizační runtime. Volitelné potvrzení
   volá `POST /api/target-staging/tasks/create-status` se **stejným
   nezměněným příkazem** a uvolňuje bariéru jen při `committed`
   potvrzeném serverem. `not_recorded` není důkaz neprovedení.
5. Offline, skrytí stránky, pagehide, BFCache a změna generace smažou
   rozpracovaný privátní text, výběr Oblasti a staré read výsledky.
   Neodmountují už odeslaný POST ani nemažou jeho marker. Znovu otevřený
   dialog bez známé aktuální identity nezačne zápis. Escape/Zavřít
   vrátí fokus na původní tlačítko/fallback FAB.

## Bezpečnostní omezení a release blokátor

Tato UI iterace **záměrně nezapisuje citlivý název úkolu do storage**.
Proto po plném reloadu nelze rekonstruovat přesný původní příkaz nutný
pro existující serverový digest receipt. Marker bezpečně **zůstává
zablokovaný**, ale současné UI jej neumí samo odblokovat. To je
**nedokončené recovery UX, blokující produkční zapnutí task capture**.
Před release je potřeba návrh bezpečného obnovitelného, actor-bound
serverového content-free recovery tokenu/receiptu, nebo jiného
samostatně schváleného řešení. Žádné časové „odblokování“, nové UUID,
přenos citlivého textu do persistence nebo domněnka ze stavu not_recorded
nejsou bezpečné náhrady.

Další omezení: UI při současné implementaci vyžaduje všechny stávající
Notes Create + Private Area transport flagy, protože znovu používá jejich
read-only Area katalog a preflight. Jde o dočasnou explicitní závislost;
samostatný task Area transport by byl další backendová iterace a
**není** v tomto PR.

## Brány a validace

- Samostatné flags: `AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED=true`
  a `AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED=true` nad
  již existujícím `targetPrivateNoteCreateUiEnabled` a serverovými
  `HTTP_ENABLED` / `HTTP_WRITE_ENABLED`. **Výchozí stav false.**
- Cílený test: `node --experimental-loader ./tests/ts-loader.mjs --test tests/target-private-task-create-ui.test.mjs`
  — flag matrix, DTO parser, no-store, exact original command receipt,
  content-free barrier, uncertain → not_recorded → committed,
  reload/generation deny a základní integrace UI.
- Existující skutečná HTTP/SQLite test suite:
  `tests/target-staging-private-task-create-http.test.mjs`,
  `tests/target-private-task-create-writer.test.mjs`.
- Nutné dokončit **cílený Playwright** 390 px / desktop se syntetickým
  HTTP a autorizovanými Area volbami; ověřit focus, offline, skutečný
  BFCache hit a revokaci. Plná Browser E2E pouze na přesném release
  SHA před produkčním nasazením podle [AGENTS.md](../AGENTS.md).
- `main` obsahuje #393; nezávisle otevřený [#391](https://github.com/Kocooour/AI-executive/pull/391)
  mění stejný shell. Před merge je nutná integrační kontrola s jeho
  aktuálním HEAD, review, úspěšné PR Checks a vyřešení všech nálezů.
- Bez reálných osobních dat, importu, resetu databáze, R4 souhlasu,
  produkční aktivace nebo nasazení. Případné další PR překračující
  tří-PR rozpočet milestone musí dostat nové rozhodnutí vlastníka.
