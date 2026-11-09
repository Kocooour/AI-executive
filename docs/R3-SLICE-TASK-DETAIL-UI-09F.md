# R3 / UI-09f — izolovaný náhled úkolu

Staging-only, výchozím stavem vypnuto. Přidává přímý read-only `/target-staging/tasks/[taskId]/preview` a volitelný odkaz z globálního indexu. Endpoint `/api/target-staging/task-temporal/detail` při každém GET znovu ověřuje aktéra, session, Area ACL a živé revize úkolu i rodiče; 404 nerozlišuje cizí a neexistující položku. Náhled není produkční detail ani aktivace R3/R4.

Stránka vyžaduje přesně `true` pro `AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED`, `AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED` a `AI_EXECUTIVE_TARGET_STAGING_TASK_CLIENT_PREVIEW_ENABLED`. Odkaz navíc vyžaduje všechny brány globálního indexu a `AI_EXECUTIVE_TARGET_STAGING_INDEX_DETAIL_LINKS_ENABLED`. Nebezpečné nebo ambivalentní URL segmenty zůstávají neklikatelné; odkaz není oprávnění a nevyvolává prefetch.

Čtení se spouští výhradně ručně, GET má no-store, same-origin a zakázané přesměrování; odpověď má omezenou velikost a přísně ověřený DTO. Zobrazuje název, stav, případný termín, typ oblasti a vlastní přiřazení. Při změně viditelnosti, ztrátě fokusu, offline, opuštění stránky a BFCache se obsah odstraní a probíhající GET zruší. Pozdní odpověď se ignoruje. Žádný zápis, trvalá cache ani produkční konfigurace.

Lokální unit testy `tests/target-staging-task-preview-ui09f.test.mjs`, `tests/target-staging-index-detail-ui09e.test.mjs`; typová kontrola projektu. Cílený workflow `Scoped UI-09f task-preview browser` používá izolovaný port 3128 a syntetické odpovědi; kontroluje výchozí 404, ruční GET, chybové stavy a ignorování pozdní odpovědi po blur/offline/pagehide. Před nasazením zůstávají příslušné R3/R4 brány.
