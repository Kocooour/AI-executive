# R3 / UI-09d — izolovaný autorizovaný náhled poznámky

**Staging-only, výchozí stav VYPNUTO.** Přidává pouze přímou, nenavigovanou adresu `/target-staging/notes/[noteId]/preview`. Nejde o produkční Notes, nový databázový model, editaci nebo přepnutí identity či oprávnění. Samostatně rozvíjí UI-09b (#310), nekoliduje s UI-09a (#308) ani UI-09c (#312).

## Serverová brána a autorizace

Server vrací **HTTP 404**, dokud nejsou přesně `true` všechny tři příznaky:
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED`
- `AI_EXECUTIVE_TARGET_STAGING_NOTE_CLIENT_PREVIEW_ENABLED`

Příznaky nikde ve výchozí aplikaci nezapínáme. Stránka má `robots: noindex,nofollow`, není v produkční navigaci. Existující GET `/api/target-staging/notes/[noteId]` ověřuje skutečného aktéra, Area ACL, aktuální členství, relaci, revize poznámky a rodiče a restore generation **na serveru při každém volání**. `404` neprozrazuje, zda je položka cizí, smazaná nebo neexistuje. Identita ani Area nejdou do klientského GET.

## Náhled

- Čte se **teprve po ručním tlačítku**. Žádné automatické obnovení, prefetch, retry ani zápis; pouze GET `same-origin`, `no-store`, `redirect:error`.
- Před vykreslením se kontroluje přesná struktura DTO, ID, délky UTF-8, JSON MIME, no-store hlavička a velikost těla odpovědi. Zobrazuje se `title`, textové `body` (nikoli interpretované HTML) a čitelné Osobní/Sdílené. Žádné `areaId`, `projectId`, actor, role nebo revize v UI; celý obsah poznámky se nikdy neposílá do URL, logu, cache ani lokálního úložiště.
- Při novém ručním čtení se předchozí text nejdříve odstraní. Po 401/403, 404, 409, 429, chybě validace, offline, hidden, `pagehide`, `blur`, `focus`, návratu z BFCache nebo unmount se výsledek skryje; rozpracovaný požadavek se přeruší a pozdní odpověď se nesmí vrátit do UI.
- Staging náhled neslibuje vzdálené vymazání obsahu, který si už uživatel uložil mimo aplikaci. Plná produkční integrace zůstává za R3/R4 bezpečnostními branami.

## Kontroly

Standardní `PR Checks`: TypeScript, relevantní unit regressions, build. Cílené `tests/target-staging-note-preview-ui09d.test.mjs` cvičí validaci, odmítnutí, limity a závody přerušení. Samostatný path-scoped workflow `Scoped UI-09d note-preview browser` na izolovaných syntetických datech a portu **3127** kontroluje HTTP 404 bez opt-in a jen specifické `e2e/note-preview-ui09d*.spec.ts`: ruční čtení, skutečný DOM, odmítnutí 401/404/409, zánik oprávnění, abort, skrytí a textové HTML. **Nespouštět celou Browser E2E sadu** před exact-SHA předprodukční release branou.

Větev `codex/ui09d-note-detail-staging-preview`; GitHub-only práce, bez sdíleného worktree, portu či testovací databáze. Žádná aktivace prostředí, produkční deploy, cutover nebo migrace.
