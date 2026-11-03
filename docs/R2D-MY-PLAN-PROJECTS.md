# R2d.3a — autorizovaný projektový přehled „Můj plán“ (staging)

Tato iterace rozšiřuje již existující default-off endpoint:

`GET /api/target-staging/project-index?scope=my-plan&limit=50&cursor=...`

Nemění datový model, produkční UI ani oprávnění. Vše je dostupné pouze při zapnutém existujícím stagingovém HTTP příznaku; v produkci zůstává vypnuté.

## Výběr a hranice přístupu

- **Osobní projekty** aktuální serverově ověřené identity se zobrazují všechny, i bez úkolů.
- **Sdílené projekty** se zobrazují pouze při aktuálním oprávnění editor/admin **a alespoň jednom úkolu přiděleném této identitě** přímo v projektu. Pouhé členství ve sdílené Oblasti (ani role viewer) nepostačuje. Sdílené projekty bez přiřazeného úkolu patří do `scope=shared`, ne do `my-plan`.
- Aktér se odvozuje z podepsané owner cookie nebo z živé durable session. Klient nemůže zadat aktéra, Area, workspace, oprávnění ani přiřazení.
- Jediný přeflightovaný a připnutý SQLite snapshot čte projekt i aktuální děděná oprávnění. Rozsahy jsou oddělené identitou, HMAC tokenem, scope a restore generací.
- Serverový subprocess vrací přesně typované projekty, autorizační linearizaci, lookahead a monotónní epochy přispívajících Oblastí. **Vnější HTTP DTO obsahuje pouze** `projects`, `hasMore` a `nextCursor`: žádný seznam členů, ID přiřazených osob, interní epochy, guardy nebo počty.
- Před vydáním HTTP odpovědi se v **jedné živé transakci** opět zkontroluje session, přístup a policy revize všech přispívajících Oblastí, project+task epochy, rodičovská Oblast všech vydaných projektů včetně lookahead a aktuální existence přiděleného úkolu pro sdílené projekty. Změny vedou k bezpečnému odmítnutí `read_stale_reload`.
- Cursor je podepsaný, vázaný na `scope=my-plan` a aktuální session, trvá nejvýše 15 minut. Přesun projektu, změna oprávnění a změna přiřazení zneplatní stránkování. Úpravy cizích Oblastí nepřidávají obsah ani související revize.

## Ověření

`tests/target-staging-project-index.test.mjs` rozšiřuje existující skutečný HTTP/SQLite test o 2–5 identit, vlastní i sdílené projekty, viewer roli, nečitelné soukromé projekty, izolaci kurzoru a zneplatnění po přiřazení/odebrání úkolu. Záměrně se nepoužívají žádná skutečná uživatelská data. Cílená workflow `R2d project read regressions` spouští tyto testy, plné `PR Checks` jsou povinné.

**Neimplementováno:** Today, Upcoming, Inbox ani Home counts, protože kanonické staging úkoly ještě nemají potřebné atributy datum/termín/stav. UI napojení je až R3 a plné browser E2E běží pouze před produkčním nasazením.
