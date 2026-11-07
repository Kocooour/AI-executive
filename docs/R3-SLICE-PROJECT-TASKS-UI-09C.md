# R3 / UI-09c — izolovaný projektový detail a úkoly (staging-only)

**Záměr:** nový, výchozí vypnutý, pouze čtecí detail jednoho projektu, který se v budoucnu může otevřít z autorizovaného globálního indexu. Není propojený s produkčním Lumi a nezasahuje do UI-09a / PR #308, title-search / UI-09b ani běžného datového modelu.

## Příznaky a bezpečnost

Dynamická adresa `/target-staging/projects/[projectId]/preview` vrací HTTP 404, pokud **současně** nejsou serverově přesně `true`:

- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED`

PR příznaky nezapíná. Stránka je `noindex,nofollow`. Po úmyslném stisku **Ověřit a načíst projekt** odešle přes `same-origin`, `no-store` jediný GET na existující staging endpoint `/api/target-staging/projects/[projectId]/tasks`. Žádné preload, autosuggest, URL query s vyhledávaným obsahem, POST/PATCH, změny identity ani předstíraná klientská oprávnění.

Server je autorita pro identitu, Area ACL, revokaci člena, rozlišování 404 od neprávem odhalených projektů, podpis kurzoru a restore generaci na **každé** stránce. Klient přijme jen přesný projektový a task DTO allowlist, dědění stejné Oblasti, seřazení ID, `no-store`, správný Content-Type, max. 1 MiB odpověď a max. 500 úkolů celkem. Interní Area ID, identity a role se nezobrazují.

## UX a ochrana paměti

Pouze název projektu a task titles; čtvercové ikony úkolů, text Osobní/Sdílený a případné **Přiřazeno mně**. Žádný automatický zápis či dotahování. Staré tituly se okamžitě skryjí během opětovného živého ověření. Po ztrátě fokusu/viditelnosti, `pagehide`, BFCache, offline a unmountu abort + vyprázdnění paměti; zobrazení se neobnoví bez výslovného načtení. Fokus při ručním načtení další stránky přejde před skrytím seznamu na trvale dostupný stavový prvek.

## Testování

Cílené unit/contract testy: `node --experimental-loader ./tests/ts-loader.mjs --test tests/target-staging-project-tasks-ui09c.test.mjs`, standardní `PR Checks` (typecheck, relevance tests, produkční build). Integrační použití se skutečnými staging oprávněními je mimo rozsah a patří do koordinované R3/integrační kontroly; celá browser E2E sada až do přesného předprodukčního gate. Testovací data výhradně syntetická.

Vývojová větev: `codex/ui09c-project-tasks-staging-preview`. Bez lokálního worktree, serveru, portu a sdílené DB (GitHub-only úprava). Pro případný ruční staging náhled používat izolovanou větev a syntetická data na portu 3002.

**Neautorizuje R4 cutover, prod deploy, odstraňování dat ani zapnutí příznaků.**
